let freshMiniPlayerWindow;

const FRESH_PLAYER_ACTIONS = {
  shuffle: () => {
    const previous = document.querySelector(
      '[data-testid="control-button-skip-back"]'
    );
    return (
      Array.from(
        document.querySelectorAll('[data-testid="now-playing-bar"] button')
      ).find((button) =>
        button.getAttribute("aria-label")?.toLowerCase().includes("shuffle")
      ) ||
      previous?.previousElementSibling
    );
  },
  previous: () =>
    document.querySelector('[data-testid="control-button-skip-back"]'),
  play: () =>
    document.querySelector('[data-testid="control-button-playpause"]'),
  next: () =>
    document.querySelector('[data-testid="control-button-skip-forward"]'),
  repeat: () =>
    document.querySelector('[data-testid="control-button-repeat"]'),
  mute: () =>
    document.querySelector('[data-testid="volume-bar-toggle-mute-button"]')
};

function formatPlaybackTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function spotifyRange(kind) {
  const ranges = document.querySelectorAll(
    '[data-testid="now-playing-bar"] input[type="range"]'
  );
  return Array.from(ranges).find((range) =>
    kind === "volume" ? Number(range.max) <= 1 : Number(range.max) > 1
  );
}

function setSpotifyRange(kind, value) {
  const range = spotifyRange(kind);
  if (!range) return;

  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    range,
    value
  );
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncFreshMiniPlayer(pipDocument) {
  const bar = document.querySelector('[data-testid="now-playing-bar"]');
  if (!bar) return;

  const cover = bar.querySelector('[data-testid="cover-art-image"]');
  const title = bar.querySelector('[data-testid="context-item-link"]');
  const artistLinks = Array.from(
    bar.querySelectorAll('[data-testid="context-item-info-artist"]')
  );
  const artists = [];
  const seenArtistIds = new Set();
  for (const artist of artistLinks) {
    const name = artist.textContent.trim();
    const id = spotifyArtistId(artist.getAttribute("href") || "");
    const key = artistHistoryKey(name);
    if (!name || seenArtistIds.has(id || key)) continue;
    seenArtistIds.add(id || key);
    artists.push({
      id,
      name,
      state:
        ready && id && key ? listeningState(id, name, key) : "resolving"
    });
  }
  const progress = spotifyRange("progress");
  const volume = spotifyRange("volume");

  pipDocument.querySelector("#fresh-player-cover").src =
    cover?.src.replace("ab67616d00004851", "ab67616d0000b273") || "";
  pipDocument.querySelector("#fresh-player-title").textContent =
    title?.textContent.trim() || "Spotify";
  const artistTarget = pipDocument.querySelector("#fresh-player-artist");
  const artistSignature = artists
    .map(({ id, name, state }) => `${id}:${name}:${state}`)
    .join("|");
      if (artistTarget.dataset.signature !== artistSignature) {
        artistTarget.replaceChildren();
        artists.forEach(({ name, state }, index) => {
          if (index) artistTarget.append(", ");
          const artistName = pipDocument.createElement("span");
          artistName.className = "fresh-player-artist-name";
          artistName.textContent = name;
          if (state === "new") {
            artistName.classList.add("fresh-player-artist-new");
            artistName.title = "Last.fm 中没有这位 artist 的 scrobble";
            artistName.setAttribute("aria-label", `${name}：Last.fm 中未听过`);
          }
          artistTarget.append(artistName);
        });
        artistTarget.dataset.signature = artistSignature;
      }

  for (const [action, findButton] of Object.entries(FRESH_PLAYER_ACTIONS)) {
    const source = findButton();
    const target = pipDocument.querySelector(`[data-action="${action}"]`);
    const label = source?.getAttribute("aria-label") || action;
    target.disabled = !source || source.disabled;
    target.setAttribute("aria-label", label);
    target.title = label;
    target.dataset.active = String(
      source?.getAttribute("aria-checked") === "true" ||
        label.toLowerCase().startsWith("disable")
    );
    if (action === "play") {
      target.dataset.playing = String(label.toLowerCase() === "pause");
    } else if (action === "mute") {
      target.dataset.muted = String(label.toLowerCase() === "unmute");
    } else if (action === "repeat") {
      target.dataset.one = String(label.toLowerCase() === "disable repeat");
    }
  }

  const progressTarget = pipDocument.querySelector("#fresh-player-progress");
  if (progress && pipDocument.activeElement !== progressTarget) {
    progressTarget.max = progress.max;
    progressTarget.step = progress.step;
    progressTarget.value = progress.value;
  }
  pipDocument.querySelector("#fresh-player-elapsed").textContent =
    formatPlaybackTime(progress?.value || 0);
  pipDocument.querySelector("#fresh-player-duration").textContent =
    formatPlaybackTime(progress?.max || 0);

  const volumeTarget = pipDocument.querySelector("#fresh-player-volume");
  if (volume && pipDocument.activeElement !== volumeTarget) {
    volumeTarget.value = volume.value;
  }
}

function renderFreshMiniPlayer(pipWindow) {
  const pipDocument = pipWindow.document;
  pipDocument.title = "Fresh Songs MiniPlayer";
  pipDocument.body.style.visibility = "hidden";
  pipDocument.body.innerHTML = `
    <main id="fresh-songs-player">
      <div class="fresh-player-stage">
        <img id="fresh-player-cover" alt="">
        <div class="fresh-player-controls">
          <button data-action="shuffle" type="button">
            <svg class="fresh-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h2c5 0 7 10 12 10h2"></path>
              <path d="m17 14 3 3-3 3M4 17h2c2 0 3.4-1.6 4.6-3.5M14 9c1.1-1.2 2.3-2 4-2h2"></path>
              <path d="m17 4 3 3-3 3"></path>
            </svg>
          </button>
          <button data-action="previous" type="button">
            <svg class="fresh-icon fresh-icon-fill" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h2.5v14H5zM19 5v14L9 12z"></path>
            </svg>
          </button>
          <button class="fresh-player-play" data-action="play" type="button">
            <svg class="fresh-icon fresh-icon-fill fresh-play-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z"></path>
            </svg>
            <svg class="fresh-icon fresh-icon-fill fresh-pause-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"></path>
            </svg>
          </button>
          <button data-action="next" type="button">
            <svg class="fresh-icon fresh-icon-fill" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M16.5 5H19v14h-2.5zM5 5v14l10-7z"></path>
            </svg>
          </button>
          <button data-action="repeat" type="button">
            <svg class="fresh-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4"></path>
            </svg>
            <span class="fresh-repeat-one">1</span>
          </button>
          <button data-action="mute" type="button">
            <svg class="fresh-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path class="fresh-speaker fresh-icon-fill" d="M4 9v6h4l5 4V5L8 9z"></path>
              <path d="M16 9a4 4 0 0 1 0 6"></path>
              <path class="fresh-mute-slash" d="m16.5 8.5 5 7"></path>
            </svg>
          </button>
          <input id="fresh-player-volume" type="range" min="0" max="1" step="0.05"
            aria-label="Volume">
        </div>
        <div class="fresh-player-timeline">
          <span id="fresh-player-elapsed">0:00</span>
          <input id="fresh-player-progress" type="range" min="0" value="0"
            aria-label="Playback position">
          <span id="fresh-player-duration">0:00</span>
        </div>
      </div>
      <section class="fresh-player-main">
        <div class="fresh-player-meta">
          <strong id="fresh-player-title"></strong>
          <span id="fresh-player-artist"></span>
        </div>
      </section>
    </main>`;

  const style = pipDocument.createElement("style");
  style.textContent = `
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { background: #121212; color: #fff; }
    #fresh-songs-player {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      grid-template-rows: auto 34px auto;
      align-items: center;
      align-content: center;
      column-gap: 8px;
      width: 100%;
      height: 100%;
      min-width: 0;
      padding: 8px;
      overflow: hidden;
    }
    .fresh-player-stage { display: contents; }
    #fresh-player-cover {
      grid-column: 1;
      grid-row: 1 / 4;
      width: 44px;
      height: 44px;
      border-radius: 4px;
      object-fit: cover;
    }
    .fresh-player-main {
      grid-column: 2;
      grid-row: 1;
      min-width: 0;
    }
    .fresh-player-meta { display: flex; min-width: 0; line-height: 1.2; }
    .fresh-player-meta strong, #fresh-player-artist {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fresh-player-meta strong { flex: 1 1 auto; font-size: 13px; }
    #fresh-player-artist {
      flex: 0 1 auto;
      margin-left: 8px;
      color: #b3b3b3;
      font-size: 11px;
    }
    .fresh-player-artist-name {
      display: inline-flex;
      align-items: center;
    }
    .fresh-player-artist-new {
      padding: 1px 3px;
      border: 1px solid #1ed760;
      border-radius: 999px;
    }
    .fresh-player-controls {
      grid-column: 2;
      grid-row: 2;
      display: flex;
      align-items: center;
      gap: 2px;
      height: 34px;
    }
    button {
      position: relative;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      padding: 5px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #b3b3b3;
      cursor: pointer;
      line-height: 1;
    }
    button:hover { color: #fff; }
    button:focus { outline: none; }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
    button:disabled { cursor: default; opacity: .35; }
    button[data-active="true"] { color: #1ed760; }
    .fresh-player-play { background: #fff; color: #000; }
    .fresh-player-play:hover { color: #000; }
    .fresh-icon {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .fresh-icon-fill { fill: currentColor; stroke: none; }
    .fresh-pause-icon,
    button[data-playing="true"] .fresh-play-icon,
    .fresh-mute-slash,
    .fresh-repeat-one { display: none; }
    button[data-playing="true"] .fresh-pause-icon,
    button[data-one="true"] .fresh-repeat-one { display: block; }
    button[data-muted="true"] .fresh-mute-slash { display: inline; }
    button[data-muted="true"] .fresh-speaker { opacity: .55; }
    .fresh-repeat-one {
      position: absolute;
      margin: 8px 0 0 8px;
      font-size: 7px;
      font-weight: 800;
      line-height: 1;
    }
    input[type="range"] { height: 12px; margin: 0; accent-color: #1ed760; }
    #fresh-player-volume { width: 52px; min-width: 32px; }
    .fresh-player-timeline {
      grid-column: 2;
      grid-row: 3;
      display: grid;
      grid-template-columns: 27px minmax(30px, 1fr) 27px;
      align-items: center;
      gap: 4px;
      color: #b3b3b3;
      font-size: 9px;
    }
    #fresh-player-duration { text-align: right; }
    #fresh-player-progress { width: 100%; }
    @media (max-width: 280px) {
      #fresh-songs-player { grid-template-columns: minmax(0, 1fr); }
      #fresh-player-cover { display: none; }
      .fresh-player-main, .fresh-player-controls, .fresh-player-timeline {
        grid-column: 1;
      }
    }
    @media (max-height: 80px) {
      #fresh-songs-player {
        display: block;
        padding: 4px 6px;
      }
      #fresh-player-cover, .fresh-player-meta, .fresh-player-timeline {
        display: none;
      }
      .fresh-player-controls { height: 100%; justify-content: center; }
    }
    @media (min-height: 180px) {
      #fresh-songs-player {
        grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
        align-items: stretch;
        gap: 0;
        padding: 0;
      }
      .fresh-player-stage {
        position: relative;
        display: grid;
        grid-template: minmax(0, 1fr) / minmax(0, 1fr);
        grid-column: 1;
        grid-row: 1;
        min-height: 0;
        overflow: hidden;
      }
      .fresh-player-stage::after {
        content: "";
        z-index: 1;
        grid-area: 1 / 1;
        background: rgba(0, 0, 0, .18);
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease;
      }
      #fresh-player-cover {
        display: block;
        grid-area: 1 / 1;
        width: 100%;
        height: 100%;
        border-radius: 0;
        object-fit: cover;
      }
      .fresh-player-main {
        grid-column: 1;
        grid-row: 2;
        padding: 10px 12px;
      }
      .fresh-player-meta { flex-direction: column; }
      .fresh-player-meta strong {
        font-size: clamp(16px, 4vw, 24px);
      }
      #fresh-player-artist {
        margin: 5px 0 0;
        font-size: clamp(12px, 3vw, 16px);
      }
      .fresh-player-controls {
        z-index: 2;
        grid-area: 1 / 1;
        align-self: center;
        justify-self: center;
        gap: 2px;
        width: max-content;
        height: auto;
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease;
      }
      .fresh-player-controls button {
        width: 32px;
        height: 32px;
        flex-basis: 32px;
        color: #fff;
        filter: drop-shadow(0 1px 2px #000);
      }
      .fresh-player-controls .fresh-player-play {
        width: 48px;
        height: 48px;
        flex-basis: 48px;
        color: #000;
        filter: none;
      }
      .fresh-player-controls .fresh-icon {
        width: 18px;
        height: 18px;
      }
      .fresh-player-controls .fresh-player-play .fresh-icon {
        width: 22px;
        height: 22px;
      }
      #fresh-player-volume {
        width: clamp(40px, 16vw, 80px);
      }
      .fresh-player-timeline {
        z-index: 2;
        grid-area: 1 / 1;
        align-self: end;
        width: 100%;
        padding: 28px 8px 8px;
        color: #fff;
        background: linear-gradient(transparent, rgba(0, 0, 0, .72));
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease;
      }
      .fresh-player-stage:hover::after,
      .fresh-player-stage:hover .fresh-player-controls,
      .fresh-player-stage:hover .fresh-player-timeline,
      .fresh-player-stage:focus-within::after,
      .fresh-player-stage:focus-within .fresh-player-controls,
      .fresh-player-stage:focus-within .fresh-player-timeline {
        opacity: 1;
      }
      .fresh-player-stage:hover .fresh-player-controls,
      .fresh-player-stage:hover .fresh-player-timeline,
      .fresh-player-stage:focus-within .fresh-player-controls,
      .fresh-player-stage:focus-within .fresh-player-timeline {
        pointer-events: auto;
      }
    }
    @media (max-width: 320px) and (min-height: 180px) {
      #fresh-player-volume { display: none; }
    }`;
  pipDocument.head.append(style);
  pipDocument.body.style.visibility = "";

  pipDocument.addEventListener("click", (event) => {
    const action = event.target.closest("button[data-action]")?.dataset.action;
    FRESH_PLAYER_ACTIONS[action]?.()?.click();
  });
  pipDocument
    .querySelector("#fresh-player-volume")
    .addEventListener("input", (event) =>
      setSpotifyRange("volume", event.target.value)
    );
  pipDocument
    .querySelector("#fresh-player-progress")
    .addEventListener("input", (event) =>
      setSpotifyRange("progress", event.target.value)
    );

  syncFreshMiniPlayer(pipDocument);
  const syncTimer = pipWindow.setInterval(
    () => syncFreshMiniPlayer(pipDocument),
    250
  );
  pipWindow.addEventListener("pagehide", () => {
    pipWindow.clearInterval(syncTimer);
    freshMiniPlayerWindow = undefined;
  });
}

async function openFreshMiniPlayer() {
  const existing = documentPictureInPicture.window;
  if (existing?.document.querySelector("#fresh-songs-player")) {
    existing.focus();
    return;
  }

  freshMiniPlayerWindow = await documentPictureInPicture.requestWindow({
    width: 340,
    height: 118
  });
  renderFreshMiniPlayer(freshMiniPlayerWindow);
}

function installFreshMiniPlayerButton() {
  if (
    !window.documentPictureInPicture ||
    document.querySelector("[data-fresh-songs-miniplayer]")
  ) {
    return;
  }

  const nativeButton = document.querySelector(
    '[data-testid="pip-toggle-button"]'
  );
  if (!nativeButton) return;

  const button = nativeButton.cloneNode(false);
  button.removeAttribute("data-testid");
  button.removeAttribute("aria-pressed");
  button.dataset.freshSongsMiniplayer = "";
  button.title = "Open compact miniplayer";
  button.setAttribute("aria-label", button.title);
  const label = document.createElement("span");
  label.textContent = "FS";
  label.style.cssText = "font-size:10px;font-weight:800;letter-spacing:-.5px";
  button.append(label);
  button.addEventListener("click", () => {
    openFreshMiniPlayer().catch((error) => console.warn("Fresh Songs:", error));
  });
  nativeButton.before(button);
}
