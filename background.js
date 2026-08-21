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
let trackResolutionQueue = Promise.resolve();
let trackDatabasePromise = null;
let mehUpdateQueue = Promise.resolve();
const trackResolutionsInFlight = new Map();

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

async function lookupTracks(keys) {
  const records = await lookupTrackIndex(keys);
  const missing = keys.filter((key) => !records[key]);
  if (!missing.length) return records;

  const stored = await chrome.storage.local.get([
    "settings",
    "trackResolutions"
  ]);
  const resolutions = stored.trackResolutions || {};
  const lastfmUser = stored.settings?.lastfmUser || "";
  const canonicalKeys = [...new Set(missing
    .map((key) => resolutions[key]?.canonicalKey)
    .filter(Boolean))];
  const canonicalRecords = canonicalKeys.length
    ? await lookupTrackIndex(canonicalKeys)
    : {};

  for (const key of missing) {
    const resolution = resolutions[key];
    if (!resolution?.canonicalKey) continue;
    if (
      Number(resolution.playcount) === 0 &&
      resolution.canonicalKey === key &&
      resolution.mbidChecked !== true
    ) continue;
    const canonical = canonicalRecords[resolution.canonicalKey];
    records[key] = resolvedTrackRecord(
      key,
      resolution,
      canonical,
      lastfmUser
    );
  }
  return records;
}

function trackLookupKeys(values) {
  return [...new Set(asArray(values)
    .slice(0, 200)
    .map((value) => String(value || ""))
    .filter((value) => value && value.length <= 700))];
}

function trackResolutionRequest(message) {
  const artist = String(message?.artist || "").trim().slice(0, 300);
  const title = String(message?.title || "").trim().slice(0, 300);
  const key = trackHistoryKey(artist, title);
  return key && key === message?.key ? { key, artist, title } : undefined;
}

function trackResolutionFrom(data, request) {
  const artist = lastFmText(data?.track?.artist) || request.artist;
  const title = lastFmText(data?.track?.name) || request.title;
  return {
    sourceKey: request.key,
    canonicalKey: trackHistoryKey(artist, title) || request.key,
    playcount: Number(data?.track?.userplaycount) || 0,
    url: lastFmText(data?.track?.url)
  };
}

function trackMbidFallbackTitle(data, identity, request) {
  if (
    Number(data?.track?.userplaycount) > 0 ||
    !lastFmText(data?.track?.mbid)
  ) return "";

  const title = lastFmText(identity?.track?.name).trim();
  return title && trackHistoryKey(request.artist, title) !== request.key
    ? title
    : "";
}

function resolvedTrackRecord(key, resolution, canonical, lastfmUser) {
  return {
    key,
    playcount: Math.max(
      Number(canonical?.playcount) || 0,
      resolution.lastfmUser === lastfmUser
        ? Number(resolution.playcount) || 0
        : 0
    ),
    url: canonical?.url || resolution.url || ""
  };
}

function latestScrobble(tracks) {
  return asArray(tracks).reduce(
    (latest, track) => Math.max(latest, Number(track?.date?.uts) || 0),
    0
  );
}

function canonicalArtistAliases(artistResolutions) {
  const bySource = Object.create(null);
  const conflicts = new Set();

  for (const [id, resolution] of Object.entries(artistResolutions || {})) {
    const sourceKey = artistHistoryKey(resolution?.sourceKey);
    const canonicalKey = artistHistoryKey(
      resolution?.canonicalKey || resolution?.canonicalName
    );
    if (!sourceKey || !canonicalKey || sourceKey === canonicalKey) continue;

    if (
      bySource[sourceKey] &&
      bySource[sourceKey].canonicalKey !== canonicalKey
    ) {
      delete bySource[sourceKey];
      conflicts.add(sourceKey);
      continue;
    }
    if (conflicts.has(sourceKey)) continue;

    const candidate = {
      canonicalKey,
      canonicalName:
        String(
          resolution.canonicalName || resolution.canonicalKey || ""
        ).trim(),
      url: String(resolution.url || ""),
      playcount: Number(resolution.playcount) || 0,
      resolvedAt: Number(resolution.resolvedAt) || 0,
      migrationRetryAfter: Number(resolution.migrationRetryAfter) || 0,
      pageStatus: String(resolution.pageStatus || ""),
      ids: [id]
    };
    const existing = bySource[sourceKey];
    if (!existing) {
      bySource[sourceKey] = candidate;
      continue;
    }

    existing.ids.push(id);
    existing.migrationRetryAfter = Math.max(
      existing.migrationRetryAfter,
      candidate.migrationRetryAfter
    );
    if (candidate.resolvedAt >= existing.resolvedAt) {
      existing.canonicalName = candidate.canonicalName;
      existing.url = candidate.url;
      existing.playcount = candidate.playcount;
      existing.resolvedAt = candidate.resolvedAt;
      existing.pageStatus = candidate.pageStatus;
    }
  }

  const byCanonical = Object.create(null);
  for (const alias of Object.values(bySource)) {
    const existing = byCanonical[alias.canonicalKey];
    if (!existing || alias.resolvedAt >= existing.resolvedAt) {
      byCanonical[alias.canonicalKey] = alias;
    }
  }
  return { bySource, byCanonical };
}

function lastFmUserPlaycount(data) {
  const raw = data?.artist?.stats?.userplaycount;
  const playcount = Number(raw);
  return raw !== undefined &&
    raw !== null &&
    raw !== "" &&
    Number.isFinite(playcount) &&
    playcount >= 0
    ? playcount
    : undefined;
}

function replaceCanonicalArtist(artistIndex, sourceKey, alias, data) {
  const source = artistIndex[sourceKey];
  const canonicalKey = alias?.canonicalKey;
  if (!source || !canonicalKey || sourceKey === canonicalKey) return false;

  const playcount = lastFmUserPlaycount(data);
  if (playcount === undefined) {
    throw new Error("Last.fm artist.getInfo returned no user playcount");
  }

  const existing = artistIndex[canonicalKey];
  const returnedKey = artistHistoryKey(lastFmText(data?.artist?.name));
  if (returnedKey !== canonicalKey) return false;

  const url =
    lastFmText(data?.artist?.url) || alias.url || existing?.url || source.url;
  const lastPlayedAt = Math.max(
    Number(existing?.lastPlayedAt) || 0,
    Number(source.lastPlayedAt) || 0
  );
  if (playcount > 0) {
    artistIndex[canonicalKey] = {
      ...existing,
      name:
        lastFmText(data?.artist?.name) ||
        alias.canonicalName ||
        existing?.name ||
        source.name,
      playcount,
      ...(url ? { url } : {}),
      ...(lastPlayedAt ? { lastPlayedAt } : {})
    };
  } else {
    delete artistIndex[canonicalKey];
  }
  delete artistIndex[sourceKey];
  return true;
}

function applyScrobbles(artistIndex, tracks, after, aliases = {}) {
  let added = 0;
  let lastScrobble = after;

  const chronological = asArray(tracks)
    .filter((track) => Number(track?.date?.uts) > after)
    .sort((a, b) => Number(a.date.uts) - Number(b.date.uts));

  for (const track of chronological) {
    const timestamp = Number(track.date.uts);
    const name = lastFmText(track.artist);
    const sourceKey = artistHistoryKey(name);
    if (!sourceKey) continue;

    const alias =
      aliases.bySource?.[sourceKey] || aliases.byCanonical?.[sourceKey];
    const key = alias?.canonicalKey || sourceKey;
    const existing = artistIndex[key];
    const url = existing?.url || alias?.url;
    const coveredByResolution =
      alias && timestamp <= Math.floor(alias.resolvedAt / 1000);
    artistIndex[key] = {
      ...existing,
      name: existing?.name || alias?.canonicalName || name,
      playcount:
        Math.max(
          Number(existing?.playcount) || 0,
          Number(alias?.playcount) || 0
        ) + (coveredByResolution ? 0 : 1),
      ...(url ? { url } : {}),
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
  const apiPlaycount = lastFmUserPlaycount(data);
  const indexedPlaycount = Number(artistIndex?.[canonicalKey]?.playcount) || 0;
  const playcount = apiPlaycount ?? indexedPlaycount;
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

function patchAliasResolutions(patches, alias, patch) {
  for (const id of alias.ids) {
    patches[id] = { ...(patches[id] || {}), ...patch };
  }
}

async function migrateCanonicalArtists(
  settings,
  artistIndex,
  aliases
) {
  const groups = new Map();
  for (const [sourceKey, alias] of Object.entries(aliases.bySource || {})) {
    if (!artistIndex[sourceKey]) continue;

    const group = groups.get(alias.canonicalKey) || [];
    group.push({ sourceKey, alias });
    groups.set(alias.canonicalKey, group);
  }

  let migrated = 0;
  const resolutionPatches = {};
  const dirtyGroups = [...groups.entries()];
  for (let index = 0; index < dirtyGroups.length; index += 1) {
    const [canonicalKey, entries] = dirtyGroups[index];
    const eligible = entries.filter(
      ({ alias }) => alias.migrationRetryAfter <= Date.now()
    );
    if (!eligible.length) continue;

    const requestAlias = eligible[0].alias;
    const authoritativeAt = Date.now();
    let data;
    try {
      data = await callLastFm(settings, "artist.getInfo", {
        artist: requestAlias.canonicalName,
        username: settings.lastfmUser,
        autocorrect: "1"
      });
    } catch (error) {
      const retryAfter = Date.now() + CANONICAL_ERROR_RETRY_MS;
      for (const { alias } of eligible) {
        patchAliasResolutions(resolutionPatches, alias, {
          migrationRetryAfter: retryAfter
        });
      }
      const globalFailure =
        error.lastFmCode === 29 ||
        error.httpStatus === 429 ||
        error.httpStatus >= 500 ||
        error instanceof TypeError;
      if (globalFailure) {
        for (const [, pendingEntries] of dirtyGroups.slice(index + 1)) {
          for (const { alias } of pendingEntries) {
            patchAliasResolutions(resolutionPatches, alias, {
              migrationRetryAfter: retryAfter
            });
          }
        }
        break;
      }
      continue;
    }

    const returnedName = lastFmText(data?.artist?.name);
    const playcount = lastFmUserPlaycount(data);
    const valid =
      artistHistoryKey(returnedName) === canonicalKey &&
      playcount !== undefined;
    for (const { sourceKey, alias } of eligible) {
      if (!valid) {
        patchAliasResolutions(resolutionPatches, alias, {
          migrationRetryAfter:
            authoritativeAt + CANONICAL_ERROR_RETRY_MS
        });
        continue;
      }

      if (replaceCanonicalArtist(artistIndex, sourceKey, alias, data)) {
        migrated += 1;
        patchAliasResolutions(resolutionPatches, alias, {
          canonicalName: returnedName,
          url: lastFmText(data?.artist?.url) || alias.url,
          playcount,
          status: playcount > 0 ? "heard" : "new",
          pageStatus: lastFmText(data?.artist?.url)
            ? "available"
            : alias.pageStatus,
          resolvedAt: authoritativeAt,
          migrationRetryAfter: 0
        });
      } else {
        patchAliasResolutions(resolutionPatches, alias, {
          migrationRetryAfter:
            authoritativeAt + CANONICAL_ERROR_RETRY_MS
        });
      }
    }
    if (index < dirtyGroups.length - 1) {
      await wait(CANONICAL_REQUEST_DELAY_MS);
    }
  }

  return { migrated, resolutionPatches };
}

async function performTrackResolution(request) {
  const cached = (await lookupTracks([request.key]))[request.key];
  if (cached) return cached;

  const stored = await chrome.storage.local.get([
    "settings",
    "trackResolutions"
  ]);
  const settings = stored.settings || {};
  if (!settings.lastfmUser || !settings.apiKey) {
    throw new Error("Last.fm settings are incomplete");
  }

  let data;
  try {
    data = await callLastFm(settings, "track.getInfo", {
      artist: request.artist,
      track: request.title,
      username: settings.lastfmUser,
      autocorrect: "1"
    });
  } catch (error) {
    if (error.lastFmCode === 6) {
      return { key: request.key, playcount: 0, url: "" };
    }
    throw error;
  }

  const mbid = lastFmText(data?.track?.mbid);
  if (Number(data?.track?.userplaycount) === 0 && mbid) {
    let identity;
    try {
      identity = await callLastFm(settings, "track.getInfo", {
        mbid,
        username: settings.lastfmUser,
        autocorrect: "1"
      });
    } catch (error) {
      if (error.lastFmCode !== 6) throw error;
    }

    const alternateTitle = trackMbidFallbackTitle(
      data,
      identity,
      request
    );
    if (alternateTitle) {
      try {
        data = await callLastFm(settings, "track.getInfo", {
          artist: request.artist,
          track: alternateTitle,
          username: settings.lastfmUser,
          autocorrect: "1"
        });
      } catch (error) {
        if (error.lastFmCode !== 6) throw error;
      }
    }
  }

  const resolution = trackResolutionFrom(data, request);
  await chrome.storage.local.set({
    trackResolutions: {
      ...(stored.trackResolutions || {}),
      [resolution.sourceKey]: {
        canonicalKey: resolution.canonicalKey,
        lastfmUser: settings.lastfmUser,
        playcount: resolution.playcount,
        url: resolution.url,
        mbidChecked: true
      }
    }
  });
  return (await lookupTracks([request.key]))[request.key];
}

function resolveTrack(message) {
  const request = trackResolutionRequest(message);
  if (!request) return Promise.reject(new Error("Invalid track identity"));

  const existing = trackResolutionsInFlight.get(request.key);
  if (existing) return existing;

  const operation = trackResolutionQueue
    .catch(() => {})
    .then(() => performTrackResolution(request));
  trackResolutionQueue = operation;
  const shared = operation.finally(() => {
    trackResolutionsInFlight.delete(request.key);
  });
  trackResolutionsInFlight.set(request.key, shared);
  return shared;
}

function staleSyncError() {
  const error = new Error("Last.fm settings changed during sync");
  error.staleSync = true;
  return error;
}

async function saveSyncUpdate(
  settings,
  update,
  artistResolutions = {},
  resolutionPatches = {}
) {
  const latest = await chrome.storage.local.get([
    "settings",
    "artistResolutions"
  ]);
  if (
    latest.settings?.lastfmUser !== settings.lastfmUser ||
    latest.settings?.apiKey !== settings.apiKey
  ) throw staleSyncError();

  const saved = { ...update };
  if (Object.keys(resolutionPatches).length) {
    const resolutions = { ...(latest.artistResolutions || {}) };
    for (const [id, patch] of Object.entries(resolutionPatches)) {
      resolutions[id] = {
        ...(resolutions[id] || artistResolutions[id] || {}),
        ...patch
      };
    }
    saved.artistResolutions = resolutions;
  }
  if (Object.keys(saved).length) {
    await chrome.storage.local.set(saved);
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
      await saveSyncUpdate(settings, {
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
  await saveSyncUpdate(settings, {});
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

async function fullSync(settings, previousMeta, artistResolutions = {}) {
  const artistIndex = {};
  const aliases = canonicalArtistAliases(artistResolutions);
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
  const migration = await migrateCanonicalArtists(
    settings,
    artistIndex,
    aliases
  );
  const syncMeta = {
    ...previousMeta,
    status: "ready",
    error: "",
    initialSyncComplete: true,
    lastScrobble,
    lastSync: Date.now(),
    ...trackMeta
  };

  await saveSyncUpdate(
    settings,
    { artistIndex, syncMeta },
    artistResolutions,
    migration.resolutionPatches
  );
  return {
    artists: Object.keys(artistIndex).length,
    tracks: trackMeta.trackCount,
    scrobbles: 0,
    migrated: migration.migrated
  };
}

async function incrementalSync(
  settings,
  previousMeta,
  artistIndex = {},
  artistResolutions = {}
) {
  if (!previousMeta.initialSyncComplete) {
    return fullSync(settings, previousMeta, artistResolutions);
  }

  const aliases = canonicalArtistAliases(artistResolutions);
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
      after,
      aliases
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

  const migration = await migrateCanonicalArtists(
    settings,
    artistIndex,
    aliases
  );
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
  if (added > 0 || migration.migrated > 0) update.artistIndex = artistIndex;
  await saveSyncUpdate(
    settings,
    update,
    artistResolutions,
    migration.resolutionPatches
  );
  return {
    artists: Object.keys(artistIndex).length,
    scrobbles: added,
    migrated: migration.migrated
  };
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
  const resolutionUpdates = {};
  let artistIndexChanged = false;
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
      const canonical = artistIndex[cached.canonicalKey];
      const legacyKey = artistHistoryKey(sourceKey);
      const legacy =
        legacyKey !== cached.canonicalKey ? artistIndex[legacyKey] : undefined;
      const playcount = Math.max(
        Number(canonical.playcount) || 0,
        Number(cached.playcount) || 0
      );
      if (legacy || playcount !== Number(canonical.playcount)) {
        artistIndex[cached.canonicalKey] = {
          ...canonical,
          name: cached.canonicalName || canonical.name,
          playcount,
          url: cached.url || canonical.url || "",
          lastPlayedAt: Math.max(
            Number(canonical.lastPlayedAt) || 0,
            Number(legacy?.lastPlayedAt) || 0
          )
        };
        if (legacy) delete artistIndex[legacyKey];
        artistIndexChanged = true;
      }
      resolutionUpdates[id] = artistResolutions[id] = {
        ...cached,
        status: "heard",
        pageStatus: "available",
        url: cached.url || artistIndex[cached.canonicalKey].url || "",
        playcount
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
      const resolution = canonicalResolutionFrom(data, name, artistIndex, now);
      resolutionUpdates[id] = artistResolutions[id] = resolution;
      const legacyKey = artistHistoryKey(sourceKey);
      if (
        legacyKey !== resolution.canonicalKey &&
        artistIndex[legacyKey]
      ) {
        artistIndexChanged =
          replaceCanonicalArtist(
            artistIndex,
            legacyKey,
            resolution,
            data
          ) || artistIndexChanged;
      }
      resolved += 1;
    } catch (error) {
      if (error.lastFmCode === 6) {
        resolutionUpdates[id] = artistResolutions[id] =
          canonicalResolutionFrom(
            { artist: { name, stats: { userplaycount: 0 } } },
            name,
            artistIndex,
            now
          );
        resolved += 1;
      } else {
        resolutionUpdates[id] = artistResolutions[id] = canonicalError(
          name,
          error,
          now
        );
        const globalFailure =
          error.lastFmCode === 29 ||
          error.httpStatus === 429 ||
          error.httpStatus >= 500;
        if (globalFailure) {
          for (const pending of requests.slice(index + 1)) {
            resolutionUpdates[pending.id] = artistResolutions[pending.id] =
              canonicalError(pending.name, error, now);
          }
          break;
        }
      }
    }

    if (index < requests.length - 1) {
      await wait(CANONICAL_REQUEST_DELAY_MS);
    }
  }

  if (Object.keys(resolutionUpdates).length || artistIndexChanged) {
    await saveSyncUpdate(
      settings,
      artistIndexChanged ? { artistIndex } : {},
      artistResolutions,
      resolutionUpdates
    );
  }
  return { resolved };
}

async function resolveCanonicalArtists(items) {
  const previous = canonicalResolutionInFlight || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      if (syncInFlight) await syncInFlight.catch(() => {});
      return performCanonicalResolution(items);
    });
  canonicalResolutionInFlight = current;

  try {
    return await current;
  } finally {
    if (canonicalResolutionInFlight === current) {
      canonicalResolutionInFlight = null;
    }
  }
}

async function storeSyncError(error, fallbackMeta, settings) {
  const latest = await chrome.storage.local.get(["settings", "syncMeta"]);
  if (
    latest.settings?.lastfmUser !== settings.lastfmUser ||
    latest.settings?.apiKey !== settings.apiKey
  ) return;

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
  const stored = await chrome.storage.local.get([
    "settings",
    "syncMeta",
    "artistIndex",
    "artistResolutions"
  ]);
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
  await saveSyncUpdate(settings, { syncMeta: syncingMeta });

  try {
    return forceFull
      ? await fullSync(
          settings,
          syncingMeta,
          stored.artistResolutions || {}
        )
      : await incrementalSync(
          settings,
          syncingMeta,
          stored.artistIndex || {},
          stored.artistResolutions || {}
        );
  } catch (error) {
    if (!error.staleSync) {
      await storeSyncError(error, syncingMeta, settings);
    }
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
  await saveSyncUpdate(settings, { syncMeta: syncingMeta });

  try {
    const trackMeta = await replaceTrackHistory(settings, syncingMeta);
    await saveSyncUpdate(settings, {
      syncMeta: {
        ...syncingMeta,
        ...trackMeta,
        status: "ready",
        error: ""
      }
    });
    return { tracks: trackMeta.trackCount };
  } catch (error) {
    if (!error.staleSync) {
      await storeSyncError(error, syncingMeta, settings);
    }
    throw error;
  }
}

async function syncArtists(forceFull = false) {
  if (syncInFlight) {
    if (!forceFull) return syncInFlight;
    await syncInFlight.catch(() => {});
  }
  if (canonicalResolutionInFlight) {
    await canonicalResolutionInFlight.catch(() => {});
  }
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

async function ensureAlarm() {
  if (!await chrome.alarms.get(SYNC_ALARM)) {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  }
}

ensureAlarm().catch(() => {});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

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
    lookupTracks(trackLookupKeys(message.keys))
      .then((tracks) => sendResponse({ ok: true, tracks }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESOLVE_TRACK") {
    resolveTrack(message)
      .then((track) => sendResponse({ ok: true, track }))
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
