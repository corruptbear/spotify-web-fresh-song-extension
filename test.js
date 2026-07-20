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
const backgroundSource = fs.readFileSync("background.js", "utf8");
vm.runInContext(backgroundSource, context);
const miniplayerSource = fs.readFileSync("miniplayer.js", "utf8");
const contentSource = fs.readFileSync("content.js", "utf8");
const contentCss = fs.readFileSync("content.css", "utf8");
const optionsSource = fs.readFileSync("options.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
vm.runInContext(miniplayerSource, context);

assert.equal(context.normalizeArtist("  Björk   Guðmundsdóttir "), "björk guðmundsdóttir");
assert.equal(
  context.trackHistoryKey("  Beyoncé ", " Halo  "),
  "beyoncé\u001fhalo"
);
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

const topTracks = context.parseTopTracksPage({
  toptracks: {
    track: [{
      name: "Halo",
      playcount: "9",
      url: "https://www.last.fm/music/Beyonc%C3%A9/_/Halo",
      artist: { name: "Beyoncé" }
    }],
    "@attr": { totalPages: "4" }
  }
});
assert.equal(topTracks.totalPages, 4);
assert.deepEqual(
  JSON.parse(JSON.stringify(topTracks.records)),
  [{
    key: "beyoncé\u001fhalo",
    playcount: 9,
    url: "https://www.last.fm/music/Beyonc%C3%A9/_/Halo"
  }]
);

const trackDeltas = new Map();
context.collectTrackDeltas(trackDeltas, [
  {
    name: "Halo",
    artist: { "#text": "Beyoncé" },
    url: "https://www.last.fm/music/Beyonc%C3%A9/_/Halo",
    date: { uts: "101" }
  },
  {
    name: "Halo",
    artist: { "#text": "Beyoncé" },
    date: { uts: "102" }
  },
  {
    name: "Still Playing",
    artist: { "#text": "Beyoncé" }
  }
], 100);
assert.deepEqual(
  JSON.parse(JSON.stringify([...trackDeltas.values()])),
  [{
    key: "beyoncé\u001fhalo",
    delta: 2,
    url: "https://www.last.fm/music/Beyonc%C3%A9/_/Halo"
  }]
);

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

assert.match(contentSource, /"Your plays"/);
assert.match(contentSource, /Last\.fm page unavailable/);
assert.match(contentSource, /hover-or-focus-tooltip/);
assert.match(contentSource, /type:\s*"LOOKUP_TRACKS"/);
assert.match(contentSource, /Your track plays/);
assert.match(contentSource, /No Last\.fm history match/);
assert.match(contentSource, /const popoverGap = isTrack \? 0 : 8/);
assert.match(contentSource, /freshSongsTrackCanonicalKey/);
assert.match(contentSource, /data-fresh-songs-track-new/);
assert.match(contentCss, /\[data-fresh-songs-track-new\]/);
assert.match(miniplayerSource, /installFreshArtistPopover\(pipDocument\)/);
assert.match(miniplayerSource, /dataset\.freshSongsTrackKey/);
assert.match(miniplayerSource, /dataset\.freshSongsTrackCanonicalKey/);
assert.match(optionsSource, /trackHistoryEnabled/);
assert.match(optionsSource, /navigator\.storage\.estimate\(\)/);
assert.match(optionsSource, /usageDetails\?\.indexedDB/);
assert.match(optionsSource, /type: tracksOnly \? "SYNC_TRACK_HISTORY"/);
assert.match(optionsSource, /const accountChanged/);
assert.match(optionsSource, /const trackHistoryChanged/);
assert.match(backgroundSource, /LASTFM_RETRY_DELAYS_MS/);
assert.match(backgroundSource, /type === "SYNC_TRACK_HISTORY"/);
assert.doesNotMatch(
  backgroundSource,
  /settings\.trackHistoryEnabled && !previousMeta\.trackSyncComplete/
);

console.log("Fresh Songs checks passed");
