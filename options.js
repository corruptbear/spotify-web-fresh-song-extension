const form = document.querySelector("#settings-form");
const userInput = document.querySelector("#lastfm-user");
const keyInput = document.querySelector("#api-key");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

let currentSettings = {};

function renderStatus(syncMeta, artistIndex, storageBytes) {
  status.classList.toggle("error", syncMeta?.status === "error");

  if (syncMeta?.status === "syncing") {
    status.textContent = "正在从 Last.fm 同步…";
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
  status.textContent += ` · 本地存储 ${(storageBytes / 1024 / 1024).toFixed(2)} MB`;
}

async function load() {
  const [stored, storageBytes] = await Promise.all([
    chrome.storage.local.get(["settings", "syncMeta", "artistIndex"]),
    chrome.storage.local.getBytesInUse(null)
  ]);
  currentSettings = stored.settings || {};
  userInput.value = currentSettings.lastfmUser || "";
  keyInput.value = currentSettings.apiKey || "";
  renderStatus(stored.syncMeta, stored.artistIndex, storageBytes);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    lastfmUser: userInput.value.trim(),
    apiKey: keyInput.value.trim()
  };
  const changed =
    settings.lastfmUser !== currentSettings.lastfmUser ||
    settings.apiKey !== currentSettings.apiKey;

  saveButton.disabled = true;
  try {
    if (changed) {
      await chrome.storage.local.set({
        settings,
        artistIndex: {},
        artistResolutions: {},
        syncMeta: { initialSyncComplete: false, status: "idle", error: "" }
      });
    } else {
      await chrome.storage.local.set({ settings });
    }
    currentSettings = settings;

    const result = await chrome.runtime.sendMessage({
      type: "SYNC_LASTFM",
      full: true
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
    (changes.syncMeta || changes.artistIndex)
  ) {
    load();
  }
});

load();
