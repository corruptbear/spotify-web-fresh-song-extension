const BADGE_CLASS = "fresh-songs-new-badge";
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLUTION_BATCH_SIZE = 10;

let artistIndex = {};
let artistResolutions = {};
let ready = false;
let stateVersion = 0;
let scheduled = false;
let pageRefreshPending = false;
let resolutionFlushScheduled = false;
let resolutionBatchInFlight = false;
let resolutionPausedUntil = 0;
const pendingRoots = new Set();
const queuedArtists = new Map();
const pendingArtistIds = new Set();
const playlistTrackPositions = new Map();
let pendingTrackLocation;

function playlistPath() {
  return location.pathname.match(/^\/playlist\/[A-Za-z0-9]+$/)?.[0] || "";
}

function spotifyTrackId(href) {
  try {
    return new URL(href, location.origin).pathname.match(
      /^\/track\/([A-Za-z0-9]{22})$/
    )?.[1] || "";
  } catch {
    return "";
  }
}

function playbackPlaylistTrack() {
  for (const link of document.querySelectorAll(
    'a[href*="/playlist/"][href*="uri="]'
  )) {
    try {
      const url = new URL(link.href);
      const path = url.pathname.match(/^\/playlist\/[A-Za-z0-9]+$/)?.[0];
      const trackId = url.searchParams
        .get("uri")
        ?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
      if (path && trackId) return { link, path, trackId };
    } catch {
      // Ignore unrelated or malformed Spotify links.
    }
  }
}

function playlistScrollNode() {
  let node = document.querySelector(
    '[data-testid="playlist-tracklist"]'
  )?.parentElement;
  while (node && node !== document.body) {
    if (
      node.scrollHeight > node.clientHeight &&
      /auto|scroll/.test(getComputedStyle(node).overflowY)
    ) {
      return node;
    }
    node = node.parentElement;
  }
}

function trackPositionKey(path, trackId) {
  return `${path}:${trackId}`;
}

function rememberRenderedTrackPositions() {
  const path = playlistPath();
  const scroller = playlistScrollNode();
  if (!path || !scroller) return;

  const scrollerRect = scroller.getBoundingClientRect();
  document
    .querySelectorAll('[data-testid="tracklist-row"]')
    .forEach((row) => {
      const link = row.querySelector('a[href^="/track/"]');
      const trackId = spotifyTrackId(link?.getAttribute("href") || "");
      if (!trackId) return;

      const rect = row.getBoundingClientRect();
      playlistTrackPositions.set(trackPositionKey(path, trackId), {
        top: scroller.scrollTop + rect.top - scrollerRect.top,
        height: rect.height
      });
    });
}

function finishPendingTrackLocation() {
  if (!pendingTrackLocation || location.pathname !== pendingTrackLocation.path) {
    return;
  }

  const scroller = playlistScrollNode();
  if (
    !scroller ||
    scroller.scrollHeight <
      pendingTrackLocation.position.top + pendingTrackLocation.position.height
  ) {
    return;
  }

  const { position } = pendingTrackLocation;
  pendingTrackLocation = undefined;
  scroller.scrollTo({
    top: Math.max(0, position.top - (scroller.clientHeight - position.height) / 2)
  });
}

function locatePlayingTrack() {
  const current = playbackPlaylistTrack();
  if (!current) return;

  const position = playlistTrackPositions.get(
    trackPositionKey(current.path, current.trackId)
  );
  if (!position) return;

  pendingTrackLocation = { ...current, position };
  if (location.pathname !== current.path) current.link.click();
  finishPendingTrackLocation();
}

function installFreshTrackLocatorButton() {
  if (document.querySelector("[data-fresh-songs-track-locator]")) return;

  const anchor =
    document.querySelector("[data-fresh-songs-miniplayer]") ||
    document.querySelector('[data-testid="pip-toggle-button"]');
  if (!anchor) return;

  const button = anchor.cloneNode(false);
  button.removeAttribute("data-testid");
  button.removeAttribute("data-fresh-songs-miniplayer");
  button.removeAttribute("aria-pressed");
  button.dataset.freshSongsTrackLocator = "";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.8">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v4m0 12v4M2 12h4m12 0h4"></path>
    </svg>`;
  button.addEventListener("click", locatePlayingTrack);
  anchor.before(button);
}

function updateFreshTrackLocatorButton() {
  const button = document.querySelector("[data-fresh-songs-track-locator]");
  if (!button) return;

  const current = playbackPlaylistTrack();
  const available =
    current &&
    playlistTrackPositions.has(
      trackPositionKey(current.path, current.trackId)
    );
  button.disabled = !available;
  button.title = available
    ? "Jump to currently playing track"
    : "Current track position has not been seen in this tab";
  button.setAttribute("aria-label", button.title);
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
    rememberRenderedTrackPositions();
    installFreshTrackLocatorButton();
    updateFreshTrackLocatorButton();
    finishPendingTrackLocation();
  });
}

function stateChanged() {
  stateVersion += 1;
  if (document.visibilityState === "visible") {
    pageRefreshPending = false;
    scheduleScan(document);
  } else {
    pageRefreshPending = true;
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get([
    "artistIndex",
    "artistResolutions",
    "syncMeta"
  ]);
  artistIndex = stored.artistIndex || {};
  artistResolutions = stored.artistResolutions || {};
  ready = Boolean(stored.syncMeta?.initialSyncComplete);
  stateChanged();
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
  if (area !== "local") return;

  const readinessChanged =
    changes.syncMeta?.oldValue?.initialSyncComplete !==
    changes.syncMeta?.newValue?.initialSyncComplete;
  if (changes.artistIndex) {
    artistIndex = changes.artistIndex.newValue || {};
  }
  if (changes.artistResolutions) {
    artistResolutions = changes.artistResolutions.newValue || {};
  }
  if (readinessChanged) {
    ready = Boolean(changes.syncMeta?.newValue?.initialSyncComplete);
  }
  if (changes.artistIndex || changes.artistResolutions || readinessChanged) {
    stateChanged();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pageRefreshPending) {
    pageRefreshPending = false;
    scheduleScan(document);
  }
});

loadState();
