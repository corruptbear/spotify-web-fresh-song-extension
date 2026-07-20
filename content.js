const BADGE_CLASS = "fresh-songs-new-badge";
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLUTION_BATCH_SIZE = 10;
const TRACK_LOOKUP_BATCH_SIZE = 100;

let artistIndex = {};
let artistResolutions = {};
let ready = false;
let trackHistoryEnabled = false;
let trackSyncComplete = false;
let trackReady = false;
let trackIndexVersion = 0;
let stateVersion = 0;
let scheduled = false;
let pageRefreshPending = false;
let resolutionFlushScheduled = false;
let resolutionBatchInFlight = false;
let resolutionPausedUntil = 0;
let trackLookupFlushScheduled = false;
let trackLookupBatchInFlight = false;
let trackLookupPausedUntil = 0;
const pendingRoots = new Set();
const queuedArtists = new Map();
const pendingArtistIds = new Set();
const trackEntries = new Map();
const queuedTrackKeys = new Set();
const pendingTrackKeys = new Set();
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

function lastFmPageUrl(value, name, known) {
  const candidate =
    value || (known && name
      ? `https://www.last.fm/music/${encodeURIComponent(name)}`
      : "");
  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    if (!["last.fm", "www.last.fm"].includes(url.hostname)) return "";
    url.protocol = "https:";
    return url.href;
  } catch {
    return "";
  }
}

function artistDetails(id, name, directKey) {
  const resolution = artistResolutions[id];
  const matches = resolution?.sourceKey === normalizeArtist(name);
  const indexed =
    matches && resolution.canonicalKey
      ? artistIndex[resolution.canonicalKey]
      : undefined;
  const entry = artistIndex[directKey] || indexed;

  if (entry) {
    const canonicalName = entry.name || resolution?.canonicalName || name;
    return {
      canonicalName,
      playcount: Number(entry.playcount) || 0,
      status: "available",
      url: lastFmPageUrl(entry.url || resolution?.url, canonicalName, true)
    };
  }

  if (!matches) {
    return { canonicalName: name, playcount: null, status: "checking", url: "" };
  }
  if (resolution.status === "error") {
    return { canonicalName: name, playcount: null, status: "error", url: "" };
  }

  const canonicalName = resolution.canonicalName || name;
  const status = resolution.pageStatus || "checking";
  return {
    canonicalName,
    playcount: Number(resolution.playcount) || 0,
    status,
    url: lastFmPageUrl(
      resolution.url,
      canonicalName,
      status === "available"
    )
  };
}

function resolvedArtistName(id, name) {
  const resolution = artistResolutions[id];
  return resolution?.sourceKey === normalizeArtist(name) &&
    resolution.canonicalName
    ? resolution.canonicalName
    : name;
}

function trackDetails(key, canonicalKey) {
  const alternateKey = canonicalKey !== key ? canonicalKey : "";
  const entry =
    trackEntries.get(key) ||
    (alternateKey ? trackEntries.get(alternateKey) : undefined);
  if (entry) {
    return {
      playcount: Number(entry.playcount) || 0,
      status: "available",
      url: lastFmPageUrl(entry.url, "", false)
    };
  }
  if (
    !trackEntries.has(key) ||
    (alternateKey && !trackEntries.has(alternateKey))
  ) {
    return { playcount: null, status: "checking", url: "" };
  }

  return { playcount: 0, status: "new", url: "" };
}

function freshPopoverTarget(node) {
  const direct = node.closest?.(
    "[data-fresh-songs-track-key], [data-fresh-songs-artist-id]"
  );
  if (direct) return direct;

  const badge = node.closest?.(`.${BADGE_CLASS}`);
  const target = badge?.previousElementSibling;
  return target?.dataset.freshSongsArtistId ? target : undefined;
}

function installFreshArtistPopover(targetDocument = document) {
  if (targetDocument.querySelector("[data-fresh-songs-artist-popover]")) return;

  const style = targetDocument.createElement("style");
  style.dataset.freshSongsPopoverStyle = "";
  style.textContent = `
    .fresh-songs-artist-popover {
      position: fixed;
      inset: auto;
      width: max-content;
      min-width: min(220px, calc(100vw - 16px));
      max-width: min(300px, calc(100vw - 16px));
      margin: 0;
      padding: 10px 12px;
      border: 1px solid #4a4a4a;
      border-radius: 8px;
      background: #242424;
      color: #fff;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .45);
      font: 13px/1.35 system-ui, sans-serif;
    }
    .fresh-songs-artist-popover::backdrop { display: none; }
    .fresh-songs-artist-popover strong {
      display: block;
      margin-bottom: 4px;
      overflow-wrap: anywhere;
      font-size: 14px;
    }
    .fresh-songs-artist-popover p {
      margin: 2px 0;
      color: #b3b3b3;
    }
    .fresh-songs-artist-popover a {
      display: inline-block;
      margin-top: 6px;
      color: #1ed760;
      font-weight: 650;
      text-decoration: none;
    }
    .fresh-songs-artist-popover a:hover { text-decoration: underline; }
    body:has(> .fresh-songs-artist-popover:popover-open)
      [data-testid="hover-or-focus-tooltip"] {
      display: none !important;
    }`;
  targetDocument.head.append(style);

  const popover = targetDocument.createElement("aside");
  popover.className = "fresh-songs-artist-popover";
  popover.dataset.freshSongsArtistPopover = "";
  popover.setAttribute("popover", "manual");
  popover.setAttribute("aria-label", "Last.fm listening details");
  popover.innerHTML = `
    <strong></strong>
    <p data-fresh-songs-plays></p>
    <p data-fresh-songs-page></p>
    <a target="_blank" rel="noopener noreferrer">Open on Last.fm ↗</a>`;
  targetDocument.body.append(popover);

  const view = targetDocument.defaultView;
  let activeTarget;
  let hideTimer;

  function hide() {
    view.clearTimeout(hideTimer);
    activeTarget = undefined;
    if (popover.matches(":popover-open")) popover.hidePopover();
  }

  function render() {
    if (!activeTarget?.isConnected) {
      hide();
      return;
    }

    const isTrack = Boolean(activeTarget.dataset.freshSongsTrackKey);
    const name = activeTarget.dataset.freshSongsArtistName || "";
    const details = isTrack
      ? trackDetails(
          activeTarget.dataset.freshSongsTrackKey,
          activeTarget.dataset.freshSongsTrackCanonicalKey
        )
      : artistDetails(
          activeTarget.dataset.freshSongsArtistId,
          name,
          activeTarget.dataset.freshSongsKey
        );
    popover.querySelector("strong").textContent = isTrack
      ? `${activeTarget.dataset.freshSongsTrackTitle} — ${name}`
      : details.canonicalName === name
        ? name
        : `${name} → ${details.canonicalName}`;
    popover.querySelector("[data-fresh-songs-plays]").textContent =
      details.playcount == null
        ? isTrack
          ? "Track play count unavailable"
          : "Play count unavailable"
        : `${isTrack ? "Your track plays" : "Your plays"}: ${
            details.playcount.toLocaleString("en-US")
          }`;

    const page = popover.querySelector("[data-fresh-songs-page]");
    const link = popover.querySelector("a");
    link.hidden = !details.url;
    link.href = details.url || "#";
    link.textContent = `Open ${isTrack ? "track " : ""}on Last.fm ↗`;
    page.hidden = Boolean(details.url);
    page.textContent =
      isTrack && details.status === "new"
        ? "No Last.fm history match"
        : isTrack && details.status === "available"
          ? "Last.fm track link unavailable"
        : details.status === "missing"
        ? "Last.fm page unavailable"
        : details.status === "error"
          ? "Last.fm temporarily unavailable"
          : isTrack
            ? "Checking local track history…"
            : "Checking Last.fm…";

    if (!popover.matches(":popover-open")) popover.showPopover();
    const targetRect = activeTarget.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const popoverGap = isTrack ? 0 : 8;
    const left = Math.min(
      Math.max(8, targetRect.left),
      Math.max(8, view.innerWidth - popoverRect.width - 8)
    );
    let top = targetRect.bottom + popoverGap;
    if (top + popoverRect.height > view.innerHeight - 8) {
      top = Math.max(
        8,
        targetRect.top - popoverRect.height - popoverGap
      );
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function show(target) {
    view.clearTimeout(hideTimer);
    activeTarget = target;
    render();
  }

  function queueHide(relatedTarget) {
    if (
      relatedTarget &&
      (activeTarget?.contains(relatedTarget) || popover.contains(relatedTarget))
    ) {
      return;
    }
    hideTimer = view.setTimeout(hide, 120);
  }

  targetDocument.addEventListener("mouseover", (event) => {
    const target = freshPopoverTarget(event.target);
    if (target) show(target);
  });
  targetDocument.addEventListener("mouseout", (event) => {
    if (activeTarget?.contains(event.target) || popover.contains(event.target)) {
      queueHide(event.relatedTarget);
    }
  });
  targetDocument.addEventListener("focusin", (event) => {
    const target = freshPopoverTarget(event.target);
    if (target) show(target);
  });
  targetDocument.addEventListener("focusout", (event) => {
    if (activeTarget?.contains(event.target) || popover.contains(event.target)) {
      queueHide(event.relatedTarget);
    }
  });
  targetDocument.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  popover.addEventListener("mouseenter", () => view.clearTimeout(hideTimer));
  popover.addEventListener("mouseleave", (event) =>
    queueHide(event.relatedTarget)
  );
  popover.freshSongsRefresh = render;
}

function refreshFreshArtistPopover(targetDocument = document) {
  targetDocument
    .querySelector("[data-fresh-songs-artist-popover]")
    ?.freshSongsRefresh?.();
}

function clearBadge(link) {
  if (link.nextElementSibling?.classList.contains(BADGE_CLASS)) {
    link.nextElementSibling.remove();
  }
  delete link.dataset.freshSongsKey;
  delete link.dataset.freshSongsVersion;
  delete link.dataset.freshSongsArtistId;
  delete link.dataset.freshSongsArtistName;
}

function clearTrackTarget(target) {
  target
    .closest('[data-testid="tracklist-row"]')
    ?.removeAttribute("data-fresh-songs-track-new");
  delete target.dataset.freshSongsTrackKey;
  delete target.dataset.freshSongsTrackCanonicalKey;
  delete target.dataset.freshSongsTrackTitle;
  delete target.dataset.freshSongsTrackVersion;
  if (!target.dataset.freshSongsArtistId) {
    delete target.dataset.freshSongsArtistName;
  }
}

function scheduleTrackLookup(key) {
  if (
    !trackReady ||
    trackEntries.has(key) ||
    pendingTrackKeys.has(key) ||
    queuedTrackKeys.has(key)
  ) {
    return;
  }

  queuedTrackKeys.add(key);
  if (
    trackLookupFlushScheduled ||
    trackLookupBatchInFlight ||
    Date.now() < trackLookupPausedUntil
  ) {
    return;
  }
  trackLookupFlushScheduled = true;
  queueMicrotask(flushTrackLookups);
}

async function flushTrackLookups() {
  trackLookupFlushScheduled = false;
  if (trackLookupBatchInFlight || !queuedTrackKeys.size) return;

  const keys = [];
  for (const key of queuedTrackKeys) {
    queuedTrackKeys.delete(key);
    pendingTrackKeys.add(key);
    keys.push(key);
    if (keys.length === TRACK_LOOKUP_BATCH_SIZE) break;
  }

  const lookupVersion = trackIndexVersion;
  trackLookupBatchInFlight = true;
  let failed = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "LOOKUP_TRACKS",
      keys
    });
    if (!response?.ok) {
      failed = true;
    } else if (lookupVersion === trackIndexVersion) {
      for (const key of keys) {
        trackEntries.set(key, response.tracks?.[key] || null);
      }
    }
  } catch {
    failed = true;
  } finally {
    for (const key of keys) pendingTrackKeys.delete(key);
    trackLookupBatchInFlight = false;

    if (failed) {
      trackLookupPausedUntil = Date.now() + 10_000;
      for (const key of keys) queuedTrackKeys.add(key);
      setTimeout(() => {
        trackLookupPausedUntil = 0;
        if (!trackLookupBatchInFlight && !trackLookupFlushScheduled) {
          trackLookupFlushScheduled = true;
          queueMicrotask(flushTrackLookups);
        }
      }, 10_000);
    } else {
      refreshFreshArtistPopover();
      scheduleScan(document);
      if (queuedTrackKeys.size) {
        trackLookupFlushScheduled = true;
        queueMicrotask(flushTrackLookups);
      }
    }
  }
}

function trackArtist(link) {
  const container =
    link.closest('[data-testid="tracklist-row"]') ||
    link.closest('[data-testid="now-playing-bar"]');
  if (!container) return;

  for (const artist of container.querySelectorAll('a[href*="/artist/"]')) {
    const id = spotifyArtistId(artist.getAttribute("href") || "");
    const name = (artist.innerText || artist.textContent || "").trim();
    if (id && name) return { id, name };
  }
}

function annotateTrackLink(link) {
  if (link.closest('[role="menu"]') || !trackReady) {
    clearTrackTarget(link);
    return;
  }

  const title = (link.innerText || link.textContent || "").trim();
  const artist = trackArtist(link);
  const key = trackHistoryKey(artist?.name, title);
  const canonicalKey =
    trackHistoryKey(
      resolvedArtistName(artist?.id, artist?.name),
      title
    ) || key;
  if (!spotifyTrackId(link.getAttribute("href") || "") || !key) {
    clearTrackTarget(link);
    return;
  }

  const unchanged =
    link.dataset.freshSongsTrackKey === key &&
    link.dataset.freshSongsTrackCanonicalKey === canonicalKey &&
    link.dataset.freshSongsTrackTitle === title &&
    link.dataset.freshSongsArtistName === artist.name &&
    link.dataset.freshSongsTrackVersion === String(trackIndexVersion);
  if (!unchanged) {
    clearTrackTarget(link);
    link.dataset.freshSongsTrackKey = key;
    link.dataset.freshSongsTrackCanonicalKey = canonicalKey;
    link.dataset.freshSongsTrackTitle = title;
    link.dataset.freshSongsTrackVersion = String(trackIndexVersion);
    link.dataset.freshSongsArtistName = artist.name;
  }

  link
    .closest('[data-testid="tracklist-row"]')
    ?.toggleAttribute(
      "data-fresh-songs-track-new",
      trackDetails(key, canonicalKey).status === "new"
    );
  scheduleTrackLookup(key);
  if (canonicalKey !== key) scheduleTrackLookup(canonicalKey);
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
  if (
    resolution?.sourceKey === sourceKey &&
    !resolution.pageStatus &&
    resolution.status !== "error"
  ) {
    scheduleCanonicalResolution(id, name);
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
  if (link.closest('[role="menu"]')) {
    clearBadge(link);
    return;
  }

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
    link.dataset.freshSongsArtistId === artistId &&
    link.dataset.freshSongsArtistName === name &&
    (!isNew || hasBadge)
  ) {
    return;
  }

  clearBadge(link);
  link.dataset.freshSongsKey = key;
  link.dataset.freshSongsVersion = String(stateVersion);
  link.dataset.freshSongsArtistId = artistId;
  link.dataset.freshSongsArtistName = name;
  if (!isNew) return;

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = "NEW";
  badge.setAttribute("aria-label", "Not in your Last.fm history");
  link.insertAdjacentElement("afterend", badge);
}

function scan(root) {
  if (!(root instanceof Element || root instanceof Document)) return;
  installFreshMiniPlayerButton();
  installFreshArtistPopover();
  if (root instanceof Element && root.matches('a[href*="/artist/"]')) {
    annotateLink(root);
  }
  if (root instanceof Element && root.matches('a[href*="/track/"]')) {
    annotateTrackLink(root);
  }
  root.querySelectorAll?.('a[href*="/artist/"]').forEach(annotateLink);
  root.querySelectorAll?.('a[href*="/track/"]').forEach(annotateTrackLink);
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
  refreshFreshArtistPopover();
  if (document.visibilityState === "visible") {
    pageRefreshPending = false;
    scheduleScan(document);
  } else {
    pageRefreshPending = true;
  }
}

async function loadState() {
  const stored = await chrome.storage.local.get([
    "settings",
    "artistIndex",
    "artistResolutions",
    "syncMeta"
  ]);
  artistIndex = stored.artistIndex || {};
  artistResolutions = stored.artistResolutions || {};
  ready = Boolean(stored.syncMeta?.initialSyncComplete);
  trackHistoryEnabled = Boolean(stored.settings?.trackHistoryEnabled);
  trackSyncComplete = Boolean(stored.syncMeta?.trackSyncComplete);
  trackReady = trackHistoryEnabled && trackSyncComplete;
  trackIndexVersion = Number(stored.syncMeta?.trackIndexVersion) || 0;
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

  const previousTrackReady = trackReady;
  const previousTrackVersion = trackIndexVersion;
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
  if (changes.settings) {
    trackHistoryEnabled = Boolean(
      changes.settings.newValue?.trackHistoryEnabled
    );
  }
  if (changes.syncMeta) {
    trackSyncComplete = Boolean(
      changes.syncMeta.newValue?.trackSyncComplete
    );
    trackIndexVersion =
      Number(changes.syncMeta.newValue?.trackIndexVersion) || 0;
  }
  trackReady = trackHistoryEnabled && trackSyncComplete;
  const trackStateChanged =
    trackReady !== previousTrackReady ||
    trackIndexVersion !== previousTrackVersion;
  if (trackStateChanged) trackEntries.clear();
  if (
    changes.artistIndex ||
    changes.artistResolutions ||
    readinessChanged ||
    trackStateChanged
  ) {
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
