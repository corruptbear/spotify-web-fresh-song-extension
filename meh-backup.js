const MEH_BACKUP_FORMAT = "fresh-songs-meh";
const MEH_BACKUP_VERSION = 1;
const MEH_BACKUP_DB = "fresh-songs-meh-backup";
const MEH_BACKUP_STORE = "files";
const MEH_BACKUP_HANDLE_KEY = "meh-data";

function normalizeMehTrackRecord(key, value = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof key !== "string" ||
    !key.includes("\u001f") ||
    key.length > 700
  ) {
    return;
  }

  const separator = key.indexOf("\u001f");
  const artist = String(value.artist || key.slice(0, separator)).trim();
  const title = String(value.title || key.slice(separator + 1)).trim();
  const updatedAt = Number(value.updatedAt);
  if (
    !artist ||
    !title ||
    artist.length > 300 ||
    title.length > 300 ||
    typeof value.meh !== "boolean" ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return;
  }
  return { artist, title, meh: value.meh, updatedAt };
}

function createMehBackup(mehTracks, now = Date.now()) {
  const tracks = [];
  for (const [key, value] of Object.entries(mehTracks || {}).sort()) {
    const record = normalizeMehTrackRecord(key, value);
    if (record) tracks.push({ key, ...record });
  }
  return {
    format: MEH_BACKUP_FORMAT,
    version: MEH_BACKUP_VERSION,
    updatedAt: new Date(now).toISOString(),
    tracks
  };
}

function parseMehBackup(value) {
  if (
    value?.format !== MEH_BACKUP_FORMAT ||
    value?.version !== MEH_BACKUP_VERSION ||
    !Array.isArray(value.tracks) ||
    value.tracks.length > 100_000
  ) {
    throw new Error("Not a supported Fresh Songs meh data file");
  }

  const mehTracks = {};
  for (const item of value.tracks) {
    const record = normalizeMehTrackRecord(item?.key, item);
    if (!record) throw new Error("Invalid track in meh data file");
    mehTracks[item.key] = record;
  }
  return mehTracks;
}

function mergeMehTracks(...indexes) {
  const merged = {};
  for (const index of indexes) {
    for (const [key, value] of Object.entries(index || {})) {
      const record = normalizeMehTrackRecord(key, value);
      if (record && record.updatedAt >= (merged[key]?.updatedAt || 0)) {
        merged[key] = record;
      }
    }
  }
  return merged;
}

function openMehBackupDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEH_BACKUP_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MEH_BACKUP_STORE)) {
        request.result.createObjectStore(MEH_BACKUP_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getMehBackupHandle() {
  const database = await openMehBackupDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MEH_BACKUP_STORE, "readonly");
    const request = transaction.objectStore(MEH_BACKUP_STORE).get(
      MEH_BACKUP_HANDLE_KEY
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function setMehBackupHandle(handle) {
  if (handle?.kind !== "file") throw new Error("A backup file is required");
  const database = await openMehBackupDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(MEH_BACKUP_STORE, "readwrite");
    transaction.objectStore(MEH_BACKUP_STORE).put(
      handle,
      MEH_BACKUP_HANDLE_KEY
    );
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function writeMehBackup(handle, mehTracks) {
  const writable = await handle.createWritable();
  try {
    await writable.write(
      `${JSON.stringify(createMehBackup(mehTracks), null, 2)}\n`
    );
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
