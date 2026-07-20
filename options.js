const form = document.querySelector("#settings-form");
const userInput = document.querySelector("#lastfm-user");
const keyInput = document.querySelector("#api-key");
const trackHistoryInput = document.querySelector("#track-history");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

let currentSettings = {};
let currentSyncMeta = {};

function renderStatus(
  syncMeta,
  artistIndex,
  storageBytes,
  trackDatabaseBytes,
  settings
) {
  status.classList.toggle("error", syncMeta?.status === "error");

  if (syncMeta?.status === "syncing") {
    const progress = syncMeta.trackSyncTotalPages
      ? ` Track history ${syncMeta.trackSyncPage}/${syncMeta.trackSyncTotalPages}`
      : "";
    status.textContent = `正在从 Last.fm 同步…${progress}`;
  } else if (syncMeta?.status === "error") {
    status.textContent = `同步失败：${syncMeta.error}`;
  } else if (syncMeta?.initialSyncComplete) {
    const count = Object.keys(artistIndex || {}).length;
    const time = syncMeta.lastSync
      ? new Date(syncMeta.lastSync).toLocaleString()
      : "未知";
    status.textContent = `已同步 ${count} 位 artist · ${time}`;
  } else {
    status.textContent = "填写设置后开始首次同步。";
  }
  if (settings?.trackHistoryEnabled && syncMeta?.trackSyncComplete) {
    status.textContent += ` · Track history: ${
      Number(syncMeta.trackCount) || 0
    } tracks`;
  }
  status.textContent += ` · Chrome storage ${
    (storageBytes / 1024 / 1024).toFixed(2)
  } MB`;
  status.textContent += ` · Track DB ${
    (trackDatabaseBytes / 1024 / 1024).toFixed(2)
  } MB`;
}

async function load() {
  const [stored, storageBytes, storageEstimate] = await Promise.all([
    chrome.storage.local.get(["settings", "syncMeta", "artistIndex"]),
    chrome.storage.local.getBytesInUse(null),
    navigator.storage.estimate()
  ]);
  currentSettings = stored.settings || {};
  currentSyncMeta = stored.syncMeta || {};
  userInput.value = currentSettings.lastfmUser || "";
  keyInput.value = currentSettings.apiKey || "";
  trackHistoryInput.checked = Boolean(currentSettings.trackHistoryEnabled);
  renderStatus(
    stored.syncMeta,
    stored.artistIndex,
    storageBytes,
    storageEstimate.usageDetails?.indexedDB || 0,
    currentSettings
  );
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    lastfmUser: userInput.value.trim(),
    apiKey: keyInput.value.trim(),
    trackHistoryEnabled: trackHistoryInput.checked
  };
  const accountChanged =
    settings.lastfmUser !== currentSettings.lastfmUser ||
    settings.apiKey !== currentSettings.apiKey;
  const trackHistoryChanged =
    settings.trackHistoryEnabled !== currentSettings.trackHistoryEnabled;
  const tracksOnly =
    !accountChanged &&
    currentSyncMeta.initialSyncComplete &&
    (trackHistoryChanged ||
      (settings.trackHistoryEnabled && !currentSyncMeta.trackSyncComplete));

  saveButton.disabled = true;
  try {
    if (accountChanged) {
      await chrome.storage.local.set({
        settings,
        artistIndex: {},
        artistResolutions: {},
        syncMeta: {
          initialSyncComplete: false,
          trackSyncComplete: false,
          trackCount: 0,
          status: "idle",
          error: ""
        }
      });
    } else {
      const update = { settings };
      if (trackHistoryChanged) {
        update.syncMeta = {
          ...currentSyncMeta,
          trackSyncComplete: false,
          trackCount: 0,
          status: "idle",
          error: ""
        };
      }
      await chrome.storage.local.set(update);
    }
    currentSettings = settings;

    const result = await chrome.runtime.sendMessage({
      type: tracksOnly ? "SYNC_TRACK_HISTORY" : "SYNC_LASTFM",
      full: !tracksOnly
    });
    if (!result?.ok) throw new Error(result?.error || "未知错误");
    await load();
  } catch (error) {
    status.classList.add("error");
    status.textContent = `同步失败：${error.message}`;
  } finally {
    saveButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    (changes.settings || changes.syncMeta || changes.artistIndex)
  ) {
    load();
  }
});

load();
