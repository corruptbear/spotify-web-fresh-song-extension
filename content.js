const BADGE_CLASS = "fresh-songs-new-badge";
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLUTION_BATCH_SIZE = 10;

let artistIndex = {};
let artistResolutions = {};
let ready = false;
let stateVersion = 0;
let scheduled = false;
let resolutionFlushScheduled = false;
let resolutionBatchInFlight = false;
let resolutionPausedUntil = 0;
const pendingRoots = new Set();
const queuedArtists = new Map();
const pendingArtistIds = new Set();

function syncLastFm() {
  try {
    chrome.runtime.sendMessage({ type: "SYNC_LASTFM" }).catch(() => {});
  } catch {
    // Reloading the extension invalidates content scripts in existing tabs.
  }
}

function clearBadge(link) {
  if (link.nextElementSibling?.classList.contains(BADGE_CLASS)) {
    link.nextElementSibling.remove();
  }
  delete link.dataset.freshSongsKey;
  delete link.dataset.freshSongsVersion;
}

function scheduleCanonicalResolution(id, name) {
  if (pendingArtistIds.has(id)) return;
  queuedArtists.set(id, { id, name });
  if (
    resolutionFlushScheduled ||
    resolutionBatchInFlight ||
    Date.now() < resolutionPausedUntil
  ) {
    return;
  }

  resolutionFlushScheduled = true;
  queueMicrotask(flushCanonicalResolutions);
}

async function flushCanonicalResolutions() {
  resolutionFlushScheduled = false;
  if (resolutionBatchInFlight || !queuedArtists.size) return;

  const artists = [];
  for (const [id, artist] of queuedArtists) {
    queuedArtists.delete(id);
    pendingArtistIds.add(id);
    artists.push(artist);
    if (artists.length === RESOLUTION_BATCH_SIZE) break;
  }

  resolutionBatchInFlight = true;
  let failed = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RESOLVE_CANONICAL_ARTISTS",
      artists
    });
    if (!response?.ok) failed = true;
  } catch {
    failed = true;
  } finally {
    for (const artist of artists) pendingArtistIds.delete(artist.id);
    resolutionBatchInFlight = false;

    if (failed) {
      resolutionPausedUntil = Date.now() + 10_000;
      for (const artist of artists) queuedArtists.set(artist.id, artist);
      setTimeout(() => {
        resolutionPausedUntil = 0;
        if (!resolutionBatchInFlight && !resolutionFlushScheduled) {
          resolutionFlushScheduled = true;
          queueMicrotask(flushCanonicalResolutions);
        }
      }, 10_000);
    } else {
      stateVersion += 1;
      scheduleScan(document);
      if (queuedArtists.size) {
        resolutionFlushScheduled = true;
        queueMicrotask(flushCanonicalResolutions);
      }
    }
  }
}

function listeningState(id, name, directKey) {
  if (artistIndex[directKey]) return "heard";

  const resolution = artistResolutions[id];
  const sourceKey = normalizeArtist(name);
  if (
    resolution?.sourceKey === sourceKey &&
    resolution.canonicalKey &&
    artistIndex[resolution.canonicalKey]
  ) {
    return "heard";
  }

  const fresh =
    resolution?.sourceKey === sourceKey &&
    Date.now() - Number(resolution.resolvedAt) < CANONICAL_CACHE_MS;
  if (fresh && resolution.status === "heard") return "heard";
  if (fresh && resolution.status === "new") return "new";
  if (
    resolution?.sourceKey === sourceKey &&
    resolution.status === "error" &&
    Number(resolution.retryAfter) > Date.now()
  ) {
    return "resolving";
  }

  scheduleCanonicalResolution(id, name);
  return "resolving";
}

function annotateLink(link) {
  const href = link.getAttribute("href") || "";
  const artistId = spotifyArtistId(href);
  if (!artistId) {
    clearBadge(link);
    return;
  }

  const name = (link.innerText || link.textContent || "").trim();
  const key = artistHistoryKey(name);
  if (!key || !ready) {
    clearBadge(link);
    return;
  }

  const state = listeningState(artistId, name, key);
  const isNew = state === "new";
  const hasBadge = link.nextElementSibling?.classList.contains(BADGE_CLASS);
  if (
    link.dataset.freshSongsKey === key &&
    link.dataset.freshSongsVersion === String(stateVersion) &&
    (!isNew || hasBadge)
  ) {
    return;
  }

  clearBadge(link);
  link.dataset.freshSongsKey = key;
  link.dataset.freshSongsVersion = String(stateVersion);
  if (!isNew) return;

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = "NEW";
  badge.title = "Last.fm 中没有这位 artist 的 scrobble";
  badge.setAttribute("aria-label", "Last.fm 中未听过");
  link.insertAdjacentElement("afterend", badge);
}

function scan(root) {
  if (!(root instanceof Element || root instanceof Document)) return;
  installFreshMiniPlayerButton();
  if (root instanceof Element && root.matches('a[href*="/artist/"]')) {
    annotateLink(root);
  }
  root.querySelectorAll?.('a[href*="/artist/"]').forEach(annotateLink);
}

function scheduleScan(root = document) {
  pendingRoots.add(root);
  if (scheduled) return;

  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const pendingRoot of pendingRoots) scan(pendingRoot);
    pendingRoots.clear();
  });
}

async function refreshState() {
  const stored = await chrome.storage.local.get([
    "artistIndex",
    "artistResolutions",
    "syncMeta"
  ]);
  artistIndex = stored.artistIndex || {};
  artistResolutions = stored.artistResolutions || {};
  ready = Boolean(stored.syncMeta?.initialSyncComplete);
  stateVersion += 1;

  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
  document.querySelectorAll("[data-fresh-songs-key]").forEach((link) => {
    delete link.dataset.freshSongsKey;
    delete link.dataset.freshSongsVersion;
  });
  scheduleScan(document);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === "attributes") {
      scheduleScan(mutation.target);
      continue;
    }
    scheduleScan(mutation.target);
    for (const node of mutation.addedNodes) {
      scheduleScan(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    }
  }
});

observer.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["href"]
});

chrome.storage.onChanged.addListener((changes, area) => {
  const readinessChanged =
    changes.syncMeta?.oldValue?.initialSyncComplete !==
    changes.syncMeta?.newValue?.initialSyncComplete;
  if (
    area === "local" &&
    (changes.artistIndex || changes.artistResolutions || readinessChanged)
  ) {
    refreshState();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    syncLastFm();
    stateVersion += 1;
    scheduleScan(document);
  }
});

refreshState();
syncLastFm();
