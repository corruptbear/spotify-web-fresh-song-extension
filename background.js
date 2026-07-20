importScripts("artist-names.js");

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const SYNC_ALARM = "sync-lastfm";
const PAGE_SIZE = 200;
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const CANONICAL_ERROR_RETRY_MS = 10 * 60 * 1000;
const CANONICAL_REQUEST_DELAY_MS = 250;

let syncInFlight = null;
let canonicalResolutionInFlight = null;

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function lastFmText(value) {
  if (typeof value === "string") return value;
  return value?.["#text"] || value?.name || "";
}

function parseLibraryPage(data, artistIndex) {
  for (const artist of asArray(data?.artists?.artist)) {
    const name = lastFmText(artist?.name);
    const key = artistHistoryKey(name);
    if (!key) continue;

    artistIndex[key] = {
      name,
      playcount: Number(artist.playcount) || 0,
      url: lastFmText(artist.url)
    };
  }

  return Number(data?.artists?.["@attr"]?.totalPages) || 1;
}

function latestScrobble(tracks) {
  return asArray(tracks).reduce(
    (latest, track) => Math.max(latest, Number(track?.date?.uts) || 0),
    0
  );
}

function applyScrobbles(artistIndex, tracks, after) {
  let added = 0;
  let lastScrobble = after;

  const chronological = asArray(tracks)
    .filter((track) => Number(track?.date?.uts) > after)
    .sort((a, b) => Number(a.date.uts) - Number(b.date.uts));

  for (const track of chronological) {
    const timestamp = Number(track.date.uts);
    const name = lastFmText(track.artist);
    const key = artistHistoryKey(name);
    if (!key) continue;

    const existing = artistIndex[key];
    artistIndex[key] = {
      ...existing,
      name: existing?.name || name,
      playcount: (Number(existing?.playcount) || 0) + 1,
      lastPlayedAt: Math.max(Number(existing?.lastPlayedAt) || 0, timestamp)
    };
    added += 1;
    lastScrobble = Math.max(lastScrobble, timestamp);
  }

  return { added, lastScrobble };
}

function canonicalResolutionFrom(data, spotifyName, artistIndex, now = Date.now()) {
  const canonicalName = lastFmText(data?.artist?.name) || spotifyName;
  const canonicalKey = artistHistoryKey(canonicalName);
  const apiPlaycount = Number(data?.artist?.stats?.userplaycount) || 0;
  const indexedPlaycount = Number(artistIndex?.[canonicalKey]?.playcount) || 0;
  const playcount = Math.max(apiPlaycount, indexedPlaycount);
  const url = lastFmText(data?.artist?.url);

  return {
    sourceKey: normalizeArtist(spotifyName),
    canonicalName,
    canonicalKey,
    mbid: lastFmText(data?.artist?.mbid),
    url,
    pageStatus: url ? "available" : "missing",
    playcount,
    status: playcount > 0 ? "heard" : "new",
    resolvedAt: now
  };
}

function canonicalError(spotifyName, error, now = Date.now()) {
  return {
    sourceKey: normalizeArtist(spotifyName),
    status: "error",
    pageStatus: "error",
    error: error.message,
    retryAfter: now + CANONICAL_ERROR_RETRY_MS,
    resolvedAt: now
  };
}

function canonicalRequests(items) {
  const unique = new Map();
  for (const item of asArray(items).slice(0, 20)) {
    const id = String(item?.id || "");
    const name = String(item?.name || "").trim().slice(0, 300);
    if (/^[A-Za-z0-9]{1,64}$/.test(id) && name) {
      unique.set(id, { id, name });
    }
  }
  return [...unique.values()];
}

async function callLastFm(settings, method, params = {}) {
  const query = new URLSearchParams({
    method,
    api_key: settings.apiKey,
    format: "json",
    ...params
  });
  const response = await fetch(`${API_ROOT}?${query}`);

  if (!response.ok) {
    const error = new Error(`Last.fm HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }

  const data = await response.json();
  if (data.error) {
    const error = new Error(data.message || `Last.fm error ${data.error}`);
    error.lastFmCode = Number(data.error);
    throw error;
  }
  return data;
}

async function fullSync(settings, previousMeta) {
  const artistIndex = {};
  let page = 1;
  let totalPages = 1;

  do {
    const data = await callLastFm(settings, "library.getArtists", {
      user: settings.lastfmUser,
      limit: String(PAGE_SIZE),
      page: String(page)
    });
    totalPages = parseLibraryPage(data, artistIndex);
    page += 1;
  } while (page <= totalPages);

  const recent = await callLastFm(settings, "user.getRecentTracks", {
    user: settings.lastfmUser,
    limit: "10",
    page: "1"
  });
  const lastScrobble = latestScrobble(recent?.recenttracks?.track);
  const syncMeta = {
    ...previousMeta,
    status: "ready",
    error: "",
    initialSyncComplete: true,
    lastScrobble,
    lastSync: Date.now()
  };

  await chrome.storage.local.set({ artistIndex, syncMeta });
  return { artists: Object.keys(artistIndex).length, scrobbles: 0 };
}

async function incrementalSync(settings, previousMeta) {
  if (!previousMeta.initialSyncComplete) {
    return fullSync(settings, previousMeta);
  }

  const stored = await chrome.storage.local.get("artistIndex");
  const artistIndex = stored.artistIndex || {};
  const after = Number(previousMeta.lastScrobble) || 0;
  const snapshotTime = Math.floor(Date.now() / 1000);
  let page = 1;
  let totalPages = 1;
  let added = 0;
  let lastScrobble = after;

  do {
    const data = await callLastFm(settings, "user.getRecentTracks", {
      user: settings.lastfmUser,
      from: String(after),
      to: String(snapshotTime),
      limit: String(PAGE_SIZE),
      page: String(page)
    });
    const result = applyScrobbles(
      artistIndex,
      data?.recenttracks?.track,
      after
    );
    added += result.added;
    lastScrobble = Math.max(lastScrobble, result.lastScrobble);
    totalPages = Number(data?.recenttracks?.["@attr"]?.totalPages) || 1;
    page += 1;
  } while (page <= totalPages);

  const syncMeta = {
    ...previousMeta,
    status: "ready",
    error: "",
    lastScrobble,
    lastSync: Date.now()
  };
  const update = { syncMeta };
  if (added > 0) update.artistIndex = artistIndex;
  await chrome.storage.local.set(update);
  return { artists: Object.keys(artistIndex).length, scrobbles: added };
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function performCanonicalResolution(items) {
  const requests = canonicalRequests(items);
  if (!requests.length) return { resolved: 0 };

  const stored = await chrome.storage.local.get([
    "settings",
    "artistIndex",
    "artistResolutions"
  ]);
  const settings = stored.settings || {};
  const artistIndex = stored.artistIndex || {};
  const artistResolutions = stored.artistResolutions || {};
  if (!settings.lastfmUser || !settings.apiKey) return { skipped: true };

  let resolved = 0;
  for (let index = 0; index < requests.length; index += 1) {
    const { id, name } = requests[index];
    const sourceKey = normalizeArtist(name);
    const cached = artistResolutions[id];
    const now = Date.now();

    if (
      cached?.sourceKey === sourceKey &&
      cached.canonicalKey &&
      artistIndex[cached.canonicalKey]
    ) {
      artistResolutions[id] = {
        ...cached,
        status: "heard",
        pageStatus: "available",
        url: cached.url || artistIndex[cached.canonicalKey].url || "",
        playcount: Number(artistIndex[cached.canonicalKey].playcount) || 1
      };
      resolved += 1;
      continue;
    }

    const fresh =
      cached?.sourceKey === sourceKey &&
      cached.pageStatus &&
      now - Number(cached.resolvedAt) < CANONICAL_CACHE_MS;
    const waitingToRetry =
      cached?.sourceKey === sourceKey &&
      cached.status === "error" &&
      Number(cached.retryAfter) > now;
    if ((fresh && cached.status !== "error") || waitingToRetry) continue;

    try {
      const data = await callLastFm(settings, "artist.getInfo", {
        artist: name,
        username: settings.lastfmUser,
        autocorrect: "1"
      });
      artistResolutions[id] = canonicalResolutionFrom(
        data,
        name,
        artistIndex,
        now
      );
      resolved += 1;
    } catch (error) {
      if (error.lastFmCode === 6) {
        artistResolutions[id] = canonicalResolutionFrom(
          { artist: { name, stats: { userplaycount: 0 } } },
          name,
          artistIndex,
          now
        );
        resolved += 1;
      } else {
        artistResolutions[id] = canonicalError(name, error, now);
        const globalFailure =
          error.lastFmCode === 29 ||
          error.httpStatus === 429 ||
          error.httpStatus >= 500;
        if (globalFailure) {
          for (const pending of requests.slice(index + 1)) {
            artistResolutions[pending.id] = canonicalError(
              pending.name,
              error,
              now
            );
          }
          break;
        }
      }
    }

    if (index < requests.length - 1) {
      await wait(CANONICAL_REQUEST_DELAY_MS);
    }
  }

  await chrome.storage.local.set({ artistResolutions });
  return { resolved };
}

async function resolveCanonicalArtists(items) {
  const previous = canonicalResolutionInFlight || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => performCanonicalResolution(items));
  canonicalResolutionInFlight = current;

  try {
    return await current;
  } finally {
    if (canonicalResolutionInFlight === current) {
      canonicalResolutionInFlight = null;
    }
  }
}

async function performSync(forceFull) {
  const stored = await chrome.storage.local.get(["settings", "syncMeta"]);
  const settings = stored.settings || {};
  const previousMeta = stored.syncMeta || {};

  if (!settings.lastfmUser || !settings.apiKey) {
    return { skipped: true };
  }

  await chrome.storage.local.set({
    syncMeta: {
      ...previousMeta,
      status: "syncing",
      error: "",
      lastAttempt: Date.now()
    }
  });

  try {
    return forceFull
      ? await fullSync(settings, previousMeta)
      : await incrementalSync(settings, previousMeta);
  } catch (error) {
    await chrome.storage.local.set({
      syncMeta: {
        ...previousMeta,
        status: "error",
        error: error.message,
        lastAttempt: Date.now()
      }
    });
    throw error;
  }
}

async function syncArtists(forceFull = false) {
  if (syncInFlight) {
    if (!forceFull) return syncInFlight;
    await syncInFlight.catch(() => {});
  }

  syncInFlight = performSync(forceFull).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

function ensureAlarm() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  ensureAlarm();
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncArtists().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SYNC_LASTFM") {
    syncArtists(Boolean(message.full))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESOLVE_CANONICAL_ARTISTS") {
    resolveCanonicalArtists(message.artists)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
