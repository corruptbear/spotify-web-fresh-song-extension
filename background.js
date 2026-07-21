importScripts("artist-names.js", "meh-backup.js");

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const SYNC_ALARM = "sync-lastfm";
const PAGE_SIZE = 200;
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const CANONICAL_ERROR_RETRY_MS = 10 * 60 * 1000;
const CANONICAL_REQUEST_DELAY_MS = 250;
const LASTFM_RETRY_DELAYS_MS = [1000, 2500, 5000];
const TRACK_DB_NAME = "fresh-songs";
const TRACK_DB_VERSION = 1;
const TRACK_STORE = "tracks";

let syncInFlight = null;
let canonicalResolutionInFlight = null;
let trackDatabasePromise = null;
let mehUpdateQueue = Promise.resolve();

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

function parseTopTracksPage(data) {
  const records = [];
  for (const track of asArray(data?.toptracks?.track)) {
    const artist = lastFmText(track?.artist);
    const title = lastFmText(track?.name);
    const key = trackHistoryKey(artist, title);
    if (!key) continue;

    records.push({
      key,
      playcount: Number(track.playcount) || 0,
      url: lastFmText(track.url)
    });
  }

  return {
    records,
    totalPages: Number(data?.toptracks?.["@attr"]?.totalPages) || 1
  };
}

function collectTrackDeltas(target, tracks, after) {
  for (const track of asArray(tracks)) {
    if (!(Number(track?.date?.uts) > after)) continue;

    const key = trackHistoryKey(
      lastFmText(track.artist),
      lastFmText(track.name)
    );
    if (!key) continue;

    const existing = target.get(key);
    target.set(key, {
      key,
      delta: (existing?.delta || 0) + 1,
      url: existing?.url || lastFmText(track.url)
    });
  }
}

function openTrackDatabase() {
  if (trackDatabasePromise) return trackDatabasePromise;

  trackDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TRACK_DB_NAME, TRACK_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TRACK_STORE)) {
        request.result.createObjectStore(TRACK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      trackDatabasePromise = null;
      reject(request.error);
    };
  });
  return trackDatabasePromise;
}

async function replaceTrackIndex(records) {
  const database = await openTrackDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    const store = transaction.objectStore(TRACK_STORE);
    store.clear();
    for (const record of records) store.put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function incrementTrackIndex(records) {
  if (!records.length) return { newTracks: 0 };

  const database = await openTrackDatabase();
  let newTracks = 0;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(TRACK_STORE, "readwrite");
    const store = transaction.objectStore(TRACK_STORE);

    for (const record of records) {
      const request = store.get(record.key);
      request.onsuccess = () => {
        const existing = request.result;
        if (!existing) newTracks += 1;
        store.put({
          key: record.key,
          playcount: (Number(existing?.playcount) || 0) + record.delta,
          url: existing?.url || record.url || ""
        });
      };
    }

    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return { newTracks };
}

async function lookupTrackIndex(keys) {
  const database = await openTrackDatabase();
  const records = {};
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(TRACK_STORE, "readonly");
    const store = transaction.objectStore(TRACK_STORE);

    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) records[key] = request.result;
      };
    }

    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return records;
}

function trackLookupKeys(values) {
  return [...new Set(asArray(values)
    .slice(0, 200)
    .map((value) => String(value || ""))
    .filter((value) => value && value.length <= 700))];
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
  const label = `${method}${params.page ? ` page ${params.page}` : ""}`;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${API_ROOT}?${query}`);
      if (!response.ok) {
        const error = new Error(`Last.fm ${label}: HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }

      const data = await response.json();
      if (data.error) {
        const error = new Error(
          `Last.fm ${label}: ${data.message || `error ${data.error}`}`
        );
        error.lastFmCode = Number(data.error);
        throw error;
      }
      return data;
    } catch (error) {
      const retryable =
        error.lastFmCode === 29 ||
        error.httpStatus === 429 ||
        error.httpStatus >= 500 ||
        error instanceof TypeError;
      if (!retryable || attempt >= LASTFM_RETRY_DELAYS_MS.length) throw error;
      await wait(LASTFM_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function replaceTrackHistory(settings, previousMeta) {
  const trackRecords = [];
  let page = 1;
  let trackTotalPages = 0;
  if (settings.trackHistoryEnabled) {
    trackTotalPages = 1;
    do {
      const data = await callLastFm(settings, "user.getTopTracks", {
        user: settings.lastfmUser,
        period: "overall",
        limit: String(PAGE_SIZE),
        page: String(page)
      });
      const result = parseTopTracksPage(data);
      trackRecords.push(...result.records);
      trackTotalPages = result.totalPages;
      await chrome.storage.local.set({
        syncMeta: {
          ...previousMeta,
          status: "syncing",
          trackSyncComplete: false,
          trackSyncPage: page,
          trackSyncTotalPages: trackTotalPages
        }
      });
      page += 1;
      if (page <= trackTotalPages) await wait(CANONICAL_REQUEST_DELAY_MS);
    } while (page <= trackTotalPages);
  }
  await replaceTrackIndex(trackRecords);

  return {
    trackSyncComplete: Boolean(settings.trackHistoryEnabled),
    trackSyncPage: trackTotalPages,
    trackSyncTotalPages: trackTotalPages,
    trackCount: trackRecords.length,
    trackIndexVersion: (Number(previousMeta.trackIndexVersion) || 0) + 1,
    trackLastSync: Date.now()
  };
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

  const trackMeta = await replaceTrackHistory(settings, previousMeta);
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
    lastSync: Date.now(),
    ...trackMeta
  };

  await chrome.storage.local.set({ artistIndex, syncMeta });
  return {
    artists: Object.keys(artistIndex).length,
    tracks: trackMeta.trackCount,
    scrobbles: 0
  };
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
  const trackDeltas = new Map();

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
    if (settings.trackHistoryEnabled) {
      collectTrackDeltas(
        trackDeltas,
        data?.recenttracks?.track,
        after
      );
    }
    added += result.added;
    lastScrobble = Math.max(lastScrobble, result.lastScrobble);
    totalPages = Number(data?.recenttracks?.["@attr"]?.totalPages) || 1;
    page += 1;
  } while (page <= totalPages);

  const trackUpdate = settings.trackHistoryEnabled
    ? await incrementTrackIndex([...trackDeltas.values()])
    : { newTracks: 0 };
  const syncMeta = {
    ...previousMeta,
    status: "ready",
    error: "",
    lastScrobble,
    lastSync: Date.now(),
    trackCount:
      (Number(previousMeta.trackCount) || 0) + trackUpdate.newTracks,
    trackIndexVersion:
      (Number(previousMeta.trackIndexVersion) || 0) +
      (trackDeltas.size ? 1 : 0)
  };
  const update = { syncMeta };
  if (added > 0) update.artistIndex = artistIndex;
  await chrome.storage.local.set(update);
  return { artists: Object.keys(artistIndex).length, scrobbles: added };
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function saveConnectedMehBackup(mehTracks) {
  let handle;
  try {
    handle = await getMehBackupHandle();
    if (!handle) return { connected: false };

    const permission = handle.queryPermission
      ? await handle.queryPermission({ mode: "readwrite" })
      : "granted";
    if (permission !== "granted") {
      throw new Error(
        "Reconnect the meh data file to resume automatic backups"
      );
    }
    await writeMehBackup(handle, mehTracks);
    await chrome.storage.local.set({
      mehBackupMeta: {
        name: handle.name || "",
        status: "ready",
        error: "",
        lastSaved: Date.now()
      }
    });
    return { connected: true };
  } catch (writeError) {
    try {
      await chrome.storage.local.set({
        mehBackupMeta: {
          name: handle?.name || "",
          status: "error",
          error: writeError.message
        }
      });
    } catch {
      // The local meh mark is already saved; backup status is secondary.
    }
    return { connected: true, error: writeError.message };
  }
}

async function performSetTrackMeh(message) {
  const updatedAt = Date.now();
  const record = {
    artist: String(message.artist || "").trim().slice(0, 300),
    title: String(message.title || "").trim().slice(0, 300),
    meh: Boolean(message.meh),
    updatedAt
  };
  const keys = [...new Set(asArray(message.keys)
    .map((key) => String(key || ""))
    .filter((key) => normalizeMehTrackRecord(key, record)))];
  if (!keys.length) throw new Error("Track identity is unavailable");

  const stored = await chrome.storage.local.get("mehTracks");
  const mehTracks = { ...(stored.mehTracks || {}) };
  for (const key of keys) mehTracks[key] = record;
  await chrome.storage.local.set({ mehTracks });
  const backup = await saveConnectedMehBackup(mehTracks);
  return {
    meh: Boolean(message.meh),
    entries: Object.values(mehTracks).filter((item) => item?.meh).length,
    backup
  };
}

function setTrackMeh(message) {
  const operation = mehUpdateQueue
    .catch(() => {})
    .then(() => performSetTrackMeh(message));
  mehUpdateQueue = operation;
  return operation;
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

async function storeSyncError(error, fallbackMeta) {
  const latest = await chrome.storage.local.get("syncMeta");
  await chrome.storage.local.set({
    syncMeta: {
      ...(latest.syncMeta || fallbackMeta),
      status: "error",
      error: error.message,
      lastAttempt: Date.now()
    }
  });
}

async function performSync(forceFull) {
  const stored = await chrome.storage.local.get(["settings", "syncMeta"]);
  const settings = stored.settings || {};
  const previousMeta = stored.syncMeta || {};

  if (!settings.lastfmUser || !settings.apiKey) {
    return { skipped: true };
  }

  const syncingMeta = {
    ...previousMeta,
    status: "syncing",
    error: "",
    lastAttempt: Date.now(),
    ...(forceFull
      ? {
          trackSyncComplete: false,
          trackSyncPage: 0,
          trackSyncTotalPages: 0
        }
      : {})
  };
  await chrome.storage.local.set({ syncMeta: syncingMeta });

  try {
    return forceFull
      ? await fullSync(settings, syncingMeta)
      : await incrementalSync(settings, syncingMeta);
  } catch (error) {
    await storeSyncError(error, syncingMeta);
    throw error;
  }
}

async function performTrackHistorySync() {
  const stored = await chrome.storage.local.get(["settings", "syncMeta"]);
  const settings = stored.settings || {};
  const previousMeta = stored.syncMeta || {};
  if (!settings.lastfmUser || !settings.apiKey) return { skipped: true };

  const syncingMeta = {
    ...previousMeta,
    status: "syncing",
    error: "",
    trackSyncComplete: false,
    trackSyncPage: 0,
    trackSyncTotalPages: 0,
    lastAttempt: Date.now()
  };
  await chrome.storage.local.set({ syncMeta: syncingMeta });

  try {
    const trackMeta = await replaceTrackHistory(settings, syncingMeta);
    await chrome.storage.local.set({
      syncMeta: {
        ...syncingMeta,
        ...trackMeta,
        status: "ready",
        error: ""
      }
    });
    return { tracks: trackMeta.trackCount };
  } catch (error) {
    await storeSyncError(error, syncingMeta);
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

async function syncTrackHistory() {
  if (syncInFlight) await syncInFlight.catch(() => {});
  syncInFlight = performTrackHistorySync().finally(() => {
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

  if (message?.type === "SYNC_TRACK_HISTORY") {
    syncTrackHistory()
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

  if (message?.type === "LOOKUP_TRACKS") {
    lookupTrackIndex(trackLookupKeys(message.keys))
      .then((tracks) => sendResponse({ ok: true, tracks }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SET_TRACK_MEH") {
    setTrackMeh(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
