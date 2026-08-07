const BADGE_CLASS = "fresh-songs-new-badge";
const CANONICAL_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLUTION_BATCH_SIZE = 10;
const TRACK_LOOKUP_BATCH_SIZE = 100;
const TRACK_RELINK_EVENT = "fresh-songs-relinkings";
const TRACK_RELINK_REQUEST_EVENT = "fresh-songs-request-relinkings";
const TRANSCRIPT_CURRENT_ATTRIBUTE =
  "data-fresh-songs-transcript-current";
const TRANSCRIPT_TEXT_SELECTOR =
  '[data-testid="episode"] section[data-encore-id="navBar"] ' +
  '[data-encore-id="text"][dir="auto"]';

let artistIndex = {};
let artistResolutions = {};
let mehTracks = {};
let trackRelinkings = {};
let trackRelinkingTitles = {};
let lastFmUser = "";
let ready = false;
let trackHistoryEnabled = false;
let trackSyncComplete = false;
let trackReady = false;
let trackIndexVersion = 0;
let trackResolutionVersion = 0;
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
const pendingTrackResolutions = new Set();
const trackResolutionErrors = new Map();
const playlistTrackPositions = new Map();
let pendingTrackLocation;
let transcriptContainer;
let transcriptCues = [];
let transcriptButtonCount = 0;
let transcriptCueIndex = -1;

function playlistPath() {
  return location.pathname.match(
    /^\/(?:playlist|album)\/[A-Za-z0-9]+$/
  )?.[0] || "";
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

function spotifyTimestampSeconds(value) {
  const parts = String(value).trim().split(":").map(Number);
  return parts.length >= 2 &&
    parts.length <= 3 &&
    parts.every(Number.isFinite)
    ? parts.reduce((seconds, part) => seconds * 60 + part, 0)
    : -1;
}

function compactJapaneseTranscriptText(value) {
  return String(value).replace(
    /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ヵヶー、。！？「」『』（）［］【】])\s+|\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ヵヶー、。！？「」『』（）［］【】])/gu,
    ""
  );
}

function normalizeJapaneseTranscript(root) {
  const targets = [];
  if (root instanceof Element && root.matches(TRANSCRIPT_TEXT_SELECTOR)) {
    targets.push(root);
  }
  root.querySelectorAll?.(TRANSCRIPT_TEXT_SELECTOR).forEach((target) => {
    targets.push(target);
  });
  for (const target of targets) {
    const compact = compactJapaneseTranscriptText(target.textContent);
    if (compact !== target.textContent) target.textContent = compact;
  }
}

function transcriptCueRows(button) {
  const rows = [];
  let row = button.parentElement?.parentElement;
  while (row && (!rows.length || !row.querySelector("button"))) {
    rows.push(row);
    row = row.nextElementSibling;
  }
  return rows;
}

function updateTranscriptAutoScroll() {
  const pageEpisodeId = location.pathname.match(
    /^\/episode\/([A-Za-z0-9]{22})$/
  )?.[1];
  const playingEpisodeId = document
    .querySelector(
      '[data-testid="now-playing-bar"] ' +
      'a[data-testid="context-item-link"][href*="/episode/"]'
    )
    ?.getAttribute("href")
    ?.match(/\/episode\/([A-Za-z0-9]{22})/)?.[1];
  const container = document.querySelector(
    '[data-testid="episode"] section[data-encore-id="navBar"]'
  );

  if (!container || !pageEpisodeId || pageEpisodeId !== playingEpisodeId) {
    if (transcriptContainer) {
      transcriptContainer
        .querySelectorAll(`[${TRANSCRIPT_CURRENT_ATTRIBUTE}]`)
        .forEach((row) => row.removeAttribute(TRANSCRIPT_CURRENT_ATTRIBUTE));
      transcriptContainer = undefined;
      transcriptCues = [];
      transcriptButtonCount = 0;
      transcriptCueIndex = -1;
    }
    return;
  }

  const buttons = container.querySelectorAll("button");
  if (
    container !== transcriptContainer ||
    buttons.length !== transcriptButtonCount ||
    (transcriptCues.length && !transcriptCues[0].button.isConnected)
  ) {
    transcriptContainer = container;
    transcriptButtonCount = buttons.length;
    transcriptCues = [...buttons]
      .map((button) => ({
        button,
        rows: transcriptCueRows(button),
        seconds: spotifyTimestampSeconds(button.textContent)
      }))
      .filter((cue) => cue.seconds >= 0);
    transcriptCueIndex = -1;
  }

  const progress = [...document.querySelectorAll(
    '[data-testid="now-playing-bar"] input[type="range"]'
  )].find((input) => Number(input.max) > 1);
  const seconds = Number(progress?.getAttribute("value")) / 1000;
  if (!Number.isFinite(seconds)) return;

  let cueIndex = transcriptCues.length - 1;
  while (cueIndex >= 0 && transcriptCues[cueIndex].seconds > seconds) {
    cueIndex -= 1;
  }
  if (cueIndex < 0 || cueIndex === transcriptCueIndex) return;

  container
    .querySelectorAll(`[${TRANSCRIPT_CURRENT_ATTRIBUTE}]`)
    .forEach((row) => row.removeAttribute(TRANSCRIPT_CURRENT_ATTRIBUTE));
  transcriptCueIndex = cueIndex;
  const cue = transcriptCues[cueIndex];
  cue.rows.forEach((row) => row.setAttribute(TRANSCRIPT_CURRENT_ATTRIBUTE, ""));
  const { button } = cue;
  button.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}

function updateTrackRelinkings(value) {
  const byId = {};
  const byTitle = {};
  const conflicts = new Set();

  for (const mapping of Array.isArray(value) ? value : []) {
    const sourceId = String(mapping?.sourceId || "");
    const linkedId = String(mapping?.linkedId || "");
    const sourceTitle = String(mapping?.sourceTitle || "").trim();
    const title = String(mapping?.title || "").trim();
    const artist = String(mapping?.artist || "").trim();
    if (
      !/^[A-Za-z0-9]{22}$/.test(sourceId) ||
      !/^[A-Za-z0-9]{22}$/.test(linkedId) ||
      !sourceTitle ||
      !title ||
      !artist
    ) continue;

    const relinking = { linkedId, sourceTitle, title, artist };
    byId[sourceId] = relinking;
    const key = trackHistoryKey(artist, sourceTitle);
    if (!key || conflicts.has(key)) continue;
    if (byTitle[key] && byTitle[key].title !== title) {
      delete byTitle[key];
      conflicts.add(key);
    } else {
      byTitle[key] = relinking;
    }
  }

  trackRelinkings = byId;
  trackRelinkingTitles = byTitle;
}

function relinkedTrackTitle(id, artist, title) {
  return trackRelinkings[id]?.title ||
    trackRelinkingTitles[trackHistoryKey(artist, title)]?.title ||
    title;
}

function playbackPlaylistTrack() {
  for (const link of document.querySelectorAll(
    'a[href*="/playlist/"][href*="uri="], a[href*="/album/"][href*="uri="]'
  )) {
    try {
      const url = new URL(link.href);
      const path = url.pathname.match(
        /^\/(?:playlist|album)\/[A-Za-z0-9]+$/
      )?.[0];
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
    '[data-testid="playlist-tracklist"], [data-testid="track-list"]'
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

function lastFmLibraryArtistUrl(name) {
  return lastFmUser && name
    ? `https://www.last.fm/user/${encodeURIComponent(lastFmUser)}/library/music/${encodeURIComponent(name)}`
    : "";
}

function artistDetails(id, name, directKey) {
  const resolution = artistResolutions[id];
  const matches = resolution?.sourceKey === normalizeArtist(name);
  const direct = artistIndex[directKey];
  const indexed =
    matches && resolution.canonicalKey
      ? artistIndex[resolution.canonicalKey]
      : undefined;
  const entry = indexed || direct;

  if (entry) {
    const canonicalName =
      (matches && resolution.canonicalName) || entry.name || name;
    return {
      canonicalName,
      playcount: Math.max(
        Number(direct?.playcount) || 0,
        Number(indexed?.playcount) || 0,
        matches ? Number(resolution.playcount) || 0 : 0
      ),
      status: "available",
      url: lastFmPageUrl(
        (matches && resolution.url) || indexed?.url || direct?.url,
        canonicalName,
        true
      )
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

function trackDetails(key, canonicalKey, sourceKey = "") {
  const alternateKey = canonicalKey !== key ? canonicalKey : "";
  const meh = Boolean(
    mehTracks[key]?.meh ||
    (alternateKey && mehTracks[alternateKey]?.meh) ||
    (sourceKey && mehTracks[sourceKey]?.meh)
  );
  const entry =
    trackEntries.get(key) ||
    (alternateKey ? trackEntries.get(alternateKey) : undefined);
  if (entry) {
    const playcount = Number(entry.playcount) || 0;
    return {
      playcount,
      status: playcount > 0 ? "available" : "new",
      url: lastFmPageUrl(entry.url, "", false),
      meh,
      resolved: true
    };
  }
  if (
    !trackEntries.has(key) ||
    (alternateKey && !trackEntries.has(alternateKey))
  ) {
    return {
      playcount: null,
      status: "checking",
      url: "",
      meh,
      resolved: false
    };
  }

  if (
    pendingTrackResolutions.has(key) ||
    (alternateKey && pendingTrackResolutions.has(alternateKey))
  ) {
    return {
      playcount: null,
      status: "checking",
      url: "",
      meh,
      resolved: false
    };
  }

  const retryAfter = Math.max(
    Number(trackResolutionErrors.get(key)) || 0,
    Number(alternateKey && trackResolutionErrors.get(alternateKey)) || 0
  );
  if (retryAfter > Date.now()) {
    return {
      playcount: null,
      status: "error",
      url: "",
      meh,
      resolved: false
    };
  }

  return {
    playcount: 0,
    status: "new",
    url: "",
    meh,
    resolved: false
  };
}

async function setTrackMeh(keys, meh, artist, title) {
  const response = await chrome.runtime.sendMessage({
    type: "SET_TRACK_MEH",
    keys,
    meh,
    artist,
    title
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not update meh data");
  }
  return response;
}

function currentPlaybackTrack() {
  const bar = document.querySelector('[data-testid="now-playing-bar"]');
  const sourceTitle = bar
    ?.querySelector('[data-testid="context-item-link"]')
    ?.textContent.trim();
  const artistLink = bar?.querySelector(
    '[data-testid="context-item-info-artist"]'
  );
  const artist = artistLink?.textContent.trim();
  const artistId = spotifyArtistId(artistLink?.getAttribute("href") || "");
  const title = relinkedTrackTitle("", artist, sourceTitle);
  const key = trackHistoryKey(artist, title);
  if (!key) return;

  return {
    artist,
    title,
    sourceKey: trackHistoryKey(artist, sourceTitle),
    key,
    canonicalKey: trackHistoryKey(
      resolvedArtistName(artistId, artist),
      title
    ) || key
  };
}

async function toggleCurrentTrackMeh() {
  const track = currentPlaybackTrack();
  if (!track) return;
  const meh = trackDetails(
    track.key,
    track.canonicalKey,
    track.sourceKey
  ).meh;
  await setTrackMeh(
    [...new Set([track.key, track.canonicalKey, track.sourceKey])],
    !meh,
    track.artist,
    track.title
  );
  if (!meh) FRESH_PLAYER_ACTIONS.next()?.click();
}

function installFreshMehButton() {
  if (document.querySelector("[data-fresh-songs-meh-skip]")) return;

  const anchor =
    document.querySelector("[data-fresh-songs-miniplayer]") ||
    document.querySelector('[data-testid="pip-toggle-button"]');
  if (!anchor) return;

  const button = anchor.cloneNode(false);
  button.removeAttribute("data-testid");
  button.removeAttribute("data-fresh-songs-miniplayer");
  button.removeAttribute("aria-pressed");
  button.dataset.freshSongsMehSkip = "";
  button.title = "Mark current track as meh and skip";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M9 9h.01M15 9h.01M8.5 16c1.8-2 5.2-2 7 0"></path>
    </svg>`;
  button.addEventListener("click", async () => {
    button.dataset.pending = "true";
    button.disabled = true;
    try {
      await toggleCurrentTrackMeh();
    } catch (error) {
      console.warn("Fresh Songs:", error);
    } finally {
      delete button.dataset.pending;
      updateFreshMehButton();
    }
  });
  anchor.before(button);
}

function updateFreshMehButton() {
  const button = document.querySelector("[data-fresh-songs-meh-skip]");
  if (button && !button.dataset.pending) {
    const track = currentPlaybackTrack();
    const meh = Boolean(
      track && trackDetails(
        track.key,
        track.canonicalKey,
        track.sourceKey
      ).meh
    );
    const label = meh
      ? "Unmark current track as meh"
      : "Mark current track as meh and skip";
    button.disabled = !track;
    button.dataset.active = String(meh);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(meh));
  }
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
  const miniplayer = targetDocument !== document;

  const style = targetDocument.createElement("style");
  style.dataset.freshSongsPopoverStyle = "";
  style.textContent = `
    .fresh-songs-artist-popover {
      position: fixed;
      inset: auto;
      z-index: 10;
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
    .fresh-songs-miniplayer-popover {
      min-width: min(180px, calc(100vw - 16px));
      max-width: min(220px, calc(100vw - 16px));
    }
    .fresh-songs-artist-popover::backdrop { display: none; }
    .fresh-songs-artist-popover[hidden] { display: none !important; }
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
    .fresh-songs-artist-popover a[hidden] { display: none !important; }
    .fresh-songs-artist-popover a:hover { text-decoration: underline; }
    .fresh-songs-artist-popover button[data-fresh-songs-meh] {
      display: inline-block;
      margin: 6px 0 0 8px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #b3b3b3;
      font: inherit;
      font-size: 18px;
      font-weight: 650;
      line-height: 1;
      cursor: pointer;
      text-decoration: none;
    }
    .fresh-songs-artist-popover button[data-fresh-songs-meh][hidden] {
      display: none;
    }
    .fresh-songs-artist-popover button[data-fresh-songs-meh]:hover {
      color: #fff;
      text-decoration: underline;
    }
    .fresh-songs-artist-popover button[data-fresh-songs-meh]:disabled {
      cursor: wait;
      opacity: .5;
    }
    body:has(> .fresh-songs-artist-popover:popover-open)
      [data-testid="hover-or-focus-tooltip"] {
      display: none !important;
    }
    body:has(> .fresh-songs-artist-popover:popover-open)
      #fresh-songs-player .fresh-player-controls,
    body:has(> .fresh-songs-artist-popover:popover-open)
      #fresh-songs-player .fresh-player-timeline {
      opacity: 0 !important;
      pointer-events: none !important;
    }`;
  targetDocument.head.append(style);

  const popover = targetDocument.createElement("aside");
  popover.className = "fresh-songs-artist-popover";
  popover.classList.toggle("fresh-songs-miniplayer-popover", miniplayer);
  popover.dataset.freshSongsArtistPopover = "";
  popover.setAttribute("popover", "manual");
  popover.hidden = true;
  popover.setAttribute("aria-label", "Last.fm listening details");
  popover.innerHTML = `
    <strong></strong>
    <p data-fresh-songs-plays></p>
    <p data-fresh-songs-page></p>
    <a target="_blank" rel="noopener noreferrer">Open on Last.fm ↗</a>
    <button data-fresh-songs-meh type="button"></button>`;
  targetDocument.body.append(popover);

  const view = targetDocument.defaultView;
  let activeTarget;
  let hoverPoint;
  let hideTimer;

  function cancelHide() {
    if (hideTimer === undefined) return;
    view.clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function hide() {
    cancelHide();
    activeTarget = undefined;
    hoverPoint = undefined;
    if (popover.matches(":popover-open")) popover.hidePopover();
    popover.hidden = true;
  }

  function render() {
    if (!activeTarget?.isConnected) {
      hide();
      return;
    }

    const isTrack = Boolean(activeTarget.dataset.freshSongsTrackKey);
    const name = activeTarget.dataset.freshSongsArtistName || "";
    const artistId = activeTarget.dataset.freshSongsArtistId;
    if (!isTrack && canonicalResolutionNeeded(artistId, name)) {
      scheduleCanonicalResolution(artistId, name);
    }
    const details = isTrack
      ? trackDetails(
          activeTarget.dataset.freshSongsTrackKey,
          activeTarget.dataset.freshSongsTrackCanonicalKey,
          activeTarget.dataset.freshSongsTrackSourceKey
        )
      : artistDetails(
          artistId,
          name,
          activeTarget.dataset.freshSongsKey
        );
    if (isTrack && details.status === "new" && !details.resolved) {
      resolveTrackTarget(activeTarget);
    }
    const trackTitle = activeTarget.dataset.freshSongsTrackTitle;
    const displayTitle =
      activeTarget.dataset.freshSongsTrackDisplayTitle || trackTitle;
    popover.querySelector("strong").textContent = isTrack
      ? `${displayTitle === trackTitle
          ? trackTitle
          : `${displayTitle} → ${trackTitle}`} — ${name}`
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
    const mehButton = popover.querySelector("[data-fresh-songs-meh]");
    const pageUrl = isTrack
      ? details.url
      : details.url && lastFmLibraryArtistUrl(details.canonicalName);
    link.hidden = !pageUrl;
    if (pageUrl) {
      link.href = pageUrl;
    } else {
      link.removeAttribute("href");
    }
    link.textContent = miniplayer
      ? "Last.fm ↗"
      : isTrack
        ? "Open track on Last.fm ↗"
        : "Open in your Last.fm library ↗";
    page.hidden = Boolean(pageUrl) || (miniplayer && details.meh);
    mehButton.hidden = !isTrack;
    const mehLabel = details.meh ? "Undo meh" : "Mark as meh";
    mehButton.textContent = "☹︎";
    mehButton.title = mehLabel;
    mehButton.setAttribute("aria-label", mehLabel);
    mehButton.style.color = details.meh ? "#1ed760" : "";
    page.textContent =
      isTrack && details.meh
        ? "Marked as meh"
        : isTrack && details.status === "new"
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

    popover.hidden = false;
    if (!popover.matches(":popover-open")) popover.showPopover();
    const targetRect = activeTarget.getBoundingClientRect();
    const verticalTargetRect = isTrack
      ? targetRect
      : activeTarget.parentElement.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const popoverGap = isTrack ? 0 : 8;
    let left = Math.min(
      Math.max(8, targetRect.left),
      Math.max(8, view.innerWidth - popoverRect.width - 8)
    );
    let top = verticalTargetRect.bottom + popoverGap;
    let positioned = false;
    if (miniplayer && hoverPoint) {
      const gap = 8;
      const clampLeft = Math.min(
        Math.max(8, hoverPoint.x - popoverRect.width / 2),
        Math.max(8, view.innerWidth - popoverRect.width - 8)
      );
      const clampTop = Math.min(
        Math.max(8, hoverPoint.y - popoverRect.height / 2),
        Math.max(8, view.innerHeight - popoverRect.height - 8)
      );
      if (hoverPoint.y - gap - popoverRect.height >= 8) {
        left = clampLeft;
        top = hoverPoint.y - gap - popoverRect.height;
        positioned = true;
      } else if (
        hoverPoint.y + gap + popoverRect.height <= view.innerHeight - 8
      ) {
        left = clampLeft;
        top = hoverPoint.y + gap;
        positioned = true;
      } else if (
        hoverPoint.x + gap + popoverRect.width <= view.innerWidth - 8
      ) {
        left = hoverPoint.x + gap;
        top = clampTop;
        positioned = true;
      } else if (hoverPoint.x - gap - popoverRect.width >= 8) {
        left = hoverPoint.x - gap - popoverRect.width;
        top = clampTop;
        positioned = true;
      }
    }
    if (!positioned && top + popoverRect.height > view.innerHeight - 8) {
      top = Math.max(
        8,
        verticalTargetRect.top - popoverRect.height - popoverGap
      );
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function show(target, point) {
    cancelHide();
    activeTarget = target;
    hoverPoint = point;
    render();
  }

  function queueHide(relatedTarget) {
    if (
      relatedTarget &&
      (activeTarget?.contains(relatedTarget) || popover.contains(relatedTarget))
    ) {
      cancelHide();
      return;
    }
    if (hideTimer !== undefined) return;
    hideTimer = view.setTimeout(hide, 80);
  }

  targetDocument.addEventListener("mouseover", (event) => {
    const target = freshPopoverTarget(event.target);
    if (target) show(target, { x: event.clientX, y: event.clientY });
  });
  targetDocument.addEventListener("mouseout", (event) => {
    if (activeTarget?.contains(event.target) || popover.contains(event.target)) {
      queueHide(event.relatedTarget);
    }
  });
  targetDocument.addEventListener("pointermove", (event) => {
    if (!activeTarget) return;
    if (
      activeTarget.contains(event.target) ||
      popover.contains(event.target)
    ) {
      cancelHide();
    } else {
      queueHide();
    }
  }, true);
  targetDocument.documentElement.addEventListener("mouseleave", hide);
  view.addEventListener("blur", hide);
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
  popover.addEventListener("mouseenter", cancelHide);
  popover.addEventListener("mouseleave", (event) =>
    queueHide(event.relatedTarget)
  );
  popover.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-fresh-songs-meh]");
    if (!button || !activeTarget?.dataset.freshSongsTrackKey) return;

    const key = activeTarget.dataset.freshSongsTrackKey;
    const canonicalKey = activeTarget.dataset.freshSongsTrackCanonicalKey;
    const sourceKey = activeTarget.dataset.freshSongsTrackSourceKey;
    const details = trackDetails(key, canonicalKey, sourceKey);
    button.disabled = true;
    try {
      await setTrackMeh(
        [...new Set([key, canonicalKey, sourceKey].filter(Boolean))],
        !details.meh,
        activeTarget.dataset.freshSongsArtistName,
        activeTarget.dataset.freshSongsTrackTitle
      );
    } catch (error) {
      const page = popover.querySelector("[data-fresh-songs-page]");
      page.hidden = false;
      page.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
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
  delete target.dataset.freshSongsTrackSourceKey;
  delete target.dataset.freshSongsTrackTitle;
  delete target.dataset.freshSongsTrackDisplayTitle;
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
  const lookupResolutionVersion = trackResolutionVersion;
  trackLookupBatchInFlight = true;
  let failed = false;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "LOOKUP_TRACKS",
      keys
    });
    if (!response?.ok) {
      failed = true;
    } else if (
      lookupVersion === trackIndexVersion &&
      lookupResolutionVersion === trackResolutionVersion
    ) {
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

async function resolveTrackTarget(target) {
  const key = target.dataset.freshSongsTrackKey;
  const retryAfter = Number(trackResolutionErrors.get(key)) || 0;
  if (!key || pendingTrackResolutions.has(key) || retryAfter > Date.now()) {
    return;
  }

  pendingTrackResolutions.add(key);
  queueMicrotask(() => refreshFreshArtistPopover(target.ownerDocument));
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RESOLVE_TRACK",
      key,
      artist: target.dataset.freshSongsArtistName,
      title: target.dataset.freshSongsTrackTitle
    });
    if (!response?.ok || !response.track) {
      throw new Error(response?.error || "Could not resolve Last.fm track");
    }
    trackEntries.set(key, response.track);
    trackResolutionErrors.delete(key);
    scheduleScan(document);
  } catch {
    trackResolutionErrors.set(key, Date.now() + 10 * 60 * 1000);
  } finally {
    pendingTrackResolutions.delete(key);
    refreshFreshArtistPopover(target.ownerDocument);
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

  const displayTitle = (link.innerText || link.textContent || "").trim();
  const artist = trackArtist(link);
  const trackId = spotifyTrackId(link.getAttribute("href") || "");
  const title = relinkedTrackTitle(trackId, artist?.name, displayTitle);
  const key = trackHistoryKey(artist?.name, title);
  const sourceKey = trackHistoryKey(artist?.name, displayTitle) || key;
  const canonicalKey =
    trackHistoryKey(
      resolvedArtistName(artist?.id, artist?.name),
      title
    ) || key;
  if (!trackId || !key) {
    clearTrackTarget(link);
    return;
  }

  const unchanged =
    link.dataset.freshSongsTrackKey === key &&
    link.dataset.freshSongsTrackCanonicalKey === canonicalKey &&
    link.dataset.freshSongsTrackSourceKey === sourceKey &&
    link.dataset.freshSongsTrackTitle === title &&
    link.dataset.freshSongsTrackDisplayTitle === displayTitle &&
    link.dataset.freshSongsArtistName === artist.name &&
    link.dataset.freshSongsTrackVersion === String(trackIndexVersion);
  if (!unchanged) {
    clearTrackTarget(link);
    link.dataset.freshSongsTrackKey = key;
    link.dataset.freshSongsTrackCanonicalKey = canonicalKey;
    link.dataset.freshSongsTrackSourceKey = sourceKey;
    link.dataset.freshSongsTrackTitle = title;
    link.dataset.freshSongsTrackDisplayTitle = displayTitle;
    link.dataset.freshSongsTrackVersion = String(trackIndexVersion);
    link.dataset.freshSongsArtistName = artist.name;
  }

  const details = trackDetails(key, canonicalKey, sourceKey);
  link
    .closest('[data-testid="tracklist-row"]')
    ?.toggleAttribute(
      "data-fresh-songs-track-new",
      details.status === "new" && !details.meh
    );
  scheduleTrackLookup(key);
  if (canonicalKey !== key) scheduleTrackLookup(canonicalKey);
}

function canonicalResolutionNeeded(id, name, now = Date.now()) {
  const resolution = artistResolutions[id];
  const matches = resolution?.sourceKey === normalizeArtist(name);
  const fresh =
    matches &&
    resolution.pageStatus &&
    now - Number(resolution.resolvedAt) < CANONICAL_CACHE_MS;
  const waitingToRetry =
    matches &&
    resolution.status === "error" &&
    Number(resolution.retryAfter) > now;
  return !fresh && !waitingToRetry;
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
  normalizeJapaneseTranscript(root);
  installFreshMiniPlayerButton();
  installFreshMehButton();
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
    updateFreshMehButton();
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
    "mehTracks",
    "syncMeta"
  ]);
  artistIndex = stored.artistIndex || {};
  artistResolutions = stored.artistResolutions || {};
  mehTracks = stored.mehTracks || {};
  lastFmUser = stored.settings?.lastfmUser || "";
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
  if (changes.mehTracks) {
    mehTracks = changes.mehTracks.newValue || {};
  }
  if (readinessChanged) {
    ready = Boolean(changes.syncMeta?.newValue?.initialSyncComplete);
  }
  if (changes.settings) {
    lastFmUser = changes.settings.newValue?.lastfmUser || "";
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
  if (trackStateChanged || changes.trackResolutions) trackEntries.clear();
  if (changes.trackResolutions) trackResolutionVersion += 1;
  if (
    changes.artistIndex ||
    changes.artistResolutions ||
    changes.trackResolutions ||
    changes.mehTracks ||
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

window.addEventListener(TRACK_RELINK_EVENT, (event) => {
  try {
    updateTrackRelinkings(JSON.parse(event.detail));
  } catch {
    return;
  }
  trackEntries.clear();
  stateChanged();
});
window.dispatchEvent(new Event(TRACK_RELINK_REQUEST_EVENT));

setInterval(updateTranscriptAutoScroll, 1000);
loadState();
