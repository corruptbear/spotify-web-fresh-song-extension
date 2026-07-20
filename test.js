const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const noopEvent = { addListener() {} };
const context = vm.createContext({
  URLSearchParams,
  fetch: async () => {
    throw new Error("Unexpected network request");
  },
  importScripts() {},
  chrome: {
    action: { onClicked: noopEvent },
    alarms: { create() {}, onAlarm: noopEvent },
    runtime: {
      onInstalled: noopEvent,
      onStartup: noopEvent,
      onMessage: noopEvent,
      openOptionsPage() {}
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {}
      }
    }
  }
});

vm.runInContext(fs.readFileSync("artist-names.js", "utf8"), context);
vm.runInContext(fs.readFileSync("background.js", "utf8"), context);
const miniplayerSource = fs.readFileSync("miniplayer.js", "utf8");
const contentSource = fs.readFileSync("content.js", "utf8");
const optionsSource = fs.readFileSync("options.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
vm.runInContext(miniplayerSource, context);

assert.equal(context.normalizeArtist("  Björk   Guðmundsdóttir "), "björk guðmundsdóttir");
assert.equal(context.formatPlaybackTime(0), "0:00");
assert.equal(context.formatPlaybackTime(162234), "2:42");
assert.match(miniplayerSource, /@media \(min-height: 180px\)/);
assert.match(
  miniplayerSource,
  /\.fresh-player-stage:hover \.fresh-player-controls/
);
assert.match(miniplayerSource, /ab67616d0000b273/);
assert.doesNotMatch(contentSource, /type:\s*"SYNC_LASTFM"/);
assert.match(
  contentSource,
  /artistIndex = changes\.artistIndex\.newValue \|\| \{\}/
);
assert.match(contentSource, /pageRefreshPending = true/);
assert.match(contentSource, /link\.closest\('\[role="menu"\]'\)/);
assert.ok(manifest.permissions.includes("unlimitedStorage"));
assert.match(optionsSource, /getBytesInUse\(null\)/);
assert.equal(context.artistHistoryKey("Ichiko Hashimoto"), context.artistHistoryKey("橋本一子"));
assert.equal(context.artistHistoryKey("SEATBELTS"), context.artistHistoryKey("The Seatbelts"));
const spotifyArtistId = "0KeSpsS2eq3BCH6ofFn2sE";
assert.equal(context.spotifyArtistId(`/artist/${spotifyArtistId}`), spotifyArtistId);
assert.equal(context.spotifyArtistId(`/artist/${spotifyArtistId}?si=test`), spotifyArtistId);
assert.equal(context.spotifyArtistId(`/artist/${spotifyArtistId}/discography/all`), "");
assert.equal(
  context.spotifyArtistId(`https://open.spotify.com/intl-ar/artist/${spotifyArtistId}`),
  ""
);

const index = {};
const totalPages = context.parseLibraryPage({
  artists: {
    artist: [{
      name: "Beyoncé",
      playcount: "12",
      url: "https://www.last.fm/music/Beyonc%C3%A9"
    }],
    "@attr": { totalPages: "3" }
  }
}, index);
assert.equal(totalPages, 3);
assert.deepEqual(
  JSON.parse(JSON.stringify(index)),
  {
    "beyoncé": {
      name: "Beyoncé",
      playcount: 12,
      url: "https://www.last.fm/music/Beyonc%C3%A9"
    }
  }
);

const result = context.applyScrobbles(index, [
  { artist: { "#text": "New Artist" }, date: { uts: "101" } },
  { artist: { "#text": "Beyoncé" }, date: { uts: "102" } },
  { artist: { "#text": "Still Playing" } }
], 100);
assert.equal(result.added, 2);
assert.equal(result.lastScrobble, 102);
assert.equal(index["new artist"].playcount, 1);
assert.equal(index["beyoncé"].playcount, 13);

const canonicalHeard = context.canonicalResolutionFrom({
  artist: {
    name: "橋本一子",
    mbid: "test-mbid",
    url: "https://www.last.fm/music/%E6%A9%8B%E6%9C%AC%E4%B8%80%E5%AD%90",
    stats: { userplaycount: "27" }
  }
}, "Ichiko Hashimoto", {}, 123);
assert.equal(canonicalHeard.canonicalName, "橋本一子");
assert.equal(canonicalHeard.status, "heard");
assert.equal(canonicalHeard.playcount, 27);
assert.equal(canonicalHeard.pageStatus, "available");

const canonicalFromIndex = context.canonicalResolutionFrom({
  artist: {
    name: "The Seatbelts",
    stats: { userplaycount: "0" }
  }
}, "SEATBELTS", {
  "the seatbelts": { name: "The Seatbelts", playcount: 8 }
}, 456);
assert.equal(canonicalFromIndex.status, "heard");
assert.equal(canonicalFromIndex.playcount, 8);

const canonicalNew = context.canonicalResolutionFrom({
  artist: {
    name: "Unheard Artist",
    url: "https://www.last.fm/music/Unheard+Artist",
    stats: { userplaycount: "0" }
  }
}, "Unheard Artist", {}, 789);
assert.equal(canonicalNew.status, "new");
assert.equal(canonicalNew.pageStatus, "available");

const canonicalMissing = context.canonicalResolutionFrom({
  artist: {
    name: "Missing Artist",
    stats: { userplaycount: "0" }
  }
}, "Missing Artist", {}, 790);
assert.equal(canonicalMissing.status, "new");
assert.equal(canonicalMissing.pageStatus, "missing");

assert.match(contentSource, /Your plays:/);
assert.match(contentSource, /Last\.fm page unavailable/);
assert.match(miniplayerSource, /installFreshArtistPopover\(pipDocument\)/);

console.log("Fresh Songs checks passed");
