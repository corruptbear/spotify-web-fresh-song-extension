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
vm.runInContext(fs.readFileSync("meh-backup.js", "utf8"), context);
const backgroundSource = fs.readFileSync("background.js", "utf8");
vm.runInContext(backgroundSource, context);
const miniplayerSource = fs.readFileSync("miniplayer.js", "utf8");
const contentSource = fs.readFileSync("content.js", "utf8");
const spotifyRelinkingSource = fs.readFileSync(
  "spotify-relinking.js",
  "utf8"
);
const contentCss = fs.readFileSync("content.css", "utf8");
const optionsSource = fs.readFileSync("options.js", "utf8");
const optionsHtml = fs.readFileSync("options.html", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
vm.runInContext(miniplayerSource, context);

const episodeId = "1234567890123456789012";
const scrolls = [];
const transcriptButtons = ["0:01", "0:05", "0:10"].map((textContent) => ({
  textContent,
  isConnected: true,
  scrollIntoView(options) { scrolls.push({ textContent, options }); }
}));
function transcriptRow(button) {
  return {
    button,
    nextElementSibling: undefined,
    attributes: new Set(),
    querySelector(selector) {
      return selector === "button" ? this.button : undefined;
    },
    setAttribute(name) { this.attributes.add(name); },
    removeAttribute(name) { this.attributes.delete(name); },
    hasAttribute(name) { return this.attributes.has(name); }
  };
}
const transcriptRows = [
  transcriptRow(transcriptButtons[0]),
  transcriptRow(),
  transcriptRow(transcriptButtons[1]),
  transcriptRow(),
  transcriptRow(),
  transcriptRow(transcriptButtons[2]),
  transcriptRow()
];
transcriptRows.forEach((row, index) => {
  row.nextElementSibling = transcriptRows[index + 1];
});
[
  [transcriptButtons[0], transcriptRows[0]],
  [transcriptButtons[1], transcriptRows[2]],
  [transcriptButtons[2], transcriptRows[5]]
].forEach(([button, row]) => {
  button.parentElement = { parentElement: row };
});
const transcriptContainer = {
  querySelectorAll(selector) {
    if (selector === "button") return transcriptButtons;
    const attribute = selector.slice(1, -1);
    return transcriptRows.filter((row) => row.hasAttribute(attribute));
  }
};
let progressValue = "6500";
const progress = {
  max: "1000000",
  getAttribute() { return progressValue; }
};
const transcriptContext = vm.createContext({
  location: { pathname: `/episode/${episodeId}` },
  document: {
    querySelector(selector) {
      if (selector.includes("context-item-link")) {
        return { getAttribute() { return `/episode/${episodeId}`; } };
      }
      return transcriptContainer;
    },
    querySelectorAll() { return [progress]; }
  }
});
vm.runInContext(
  contentSource.slice(
    contentSource.indexOf("const TRANSCRIPT_CURRENT_ATTRIBUTE"),
    contentSource.indexOf("\nfunction updateTrackRelinkings")
  ),
  transcriptContext
);
transcriptContext.updateTranscriptAutoScroll();

assert.equal(context.normalizeArtist("  Björk   Guðmundsdóttir "), "björk guðmundsdóttir");
assert.equal(
  context.trackHistoryKey("  Beyoncé ", " Halo  "),
  "beyoncé\u001fhalo"
);
assert.equal(context.formatPlaybackTime(0), "0:00");
assert.equal(context.formatPlaybackTime(162234), "2:42");
assert.equal(transcriptContext.spotifyTimestampSeconds("0:01"), 1);
assert.equal(transcriptContext.spotifyTimestampSeconds("1:02:03"), 3723);
assert.equal(transcriptContext.spotifyTimestampSeconds("not a time"), -1);
assert.deepEqual(JSON.parse(JSON.stringify(scrolls)), [{
  textContent: "0:05",
  options: { behavior: "smooth", block: "center" }
}]);
assert.deepEqual(transcriptRows.map((row) => row.hasAttribute(
  "data-fresh-songs-transcript-current"
)), [false, false, true, true, true, false, false]);
progressValue = "10500";
transcriptContext.updateTranscriptAutoScroll();
assert.deepEqual(transcriptRows.map((row) => row.hasAttribute(
  "data-fresh-songs-transcript-current"
)), [false, false, false, false, false, true, true]);
assert.match(contentCss, /data-fresh-songs-transcript-current/);
assert.match(contentCss, /user-select:\s*text !important/);
assert.match(contentCss, /::selection/);
assert.match(contentCss, /background:\s*Highlight;/);
assert.match(contentCss, /color:\s*HighlightText;/);
const mehKey = context.trackHistoryKey("Unheard Artist", "Skipped Track");
const mehBackup = context.createMehBackup({
  [mehKey]: {
    artist: "Unheard Artist",
    title: "Skipped Track",
    meh: true,
    updatedAt: 100
  }
}, 200);
assert.equal(mehBackup.format, "fresh-songs-meh");
assert.equal(mehBackup.version, 1);
assert.equal(mehBackup.tracks.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.parseMehBackup(mehBackup))),
  {
    [mehKey]: {
      artist: "Unheard Artist",
      title: "Skipped Track",
      meh: true,
      updatedAt: 100
    }
  }
);
assert.equal(
  context.mergeMehTracks(
    { [mehKey]: { ...mehBackup.tracks[0], meh: true, updatedAt: 100 } },
    { [mehKey]: { ...mehBackup.tracks[0], meh: false, updatedAt: 101 } }
  )[mehKey].meh,
  false
);
assert.throws(
  () => context.parseMehBackup({ format: "other", version: 1, tracks: [] }),
  /Not a supported/
);
assert.throws(
  () => context.parseMehBackup({
    format: "fresh-songs-meh",
    version: 1,
    tracks: [{ key: mehKey }]
  }),
  /Invalid track/
);
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
assert.match(contentSource, /\(\?:playlist\|album\)/);
assert.match(contentSource, /a\[href\*="\/album\/"\]\[href\*="uri="\]/);
assert.match(contentSource, /\[data-testid="track-list"\]/);
assert.match(contentSource, /trackStateChanged \|\| changes\.trackResolutions/);
assert.match(contentSource, /lookupResolutionVersion === trackResolutionVersion/);
assert.match(contentSource, /trackResolutionVersion \+= 1/);
assert.match(contentSource, /pageRefreshPending = true/);
assert.match(contentSource, /link\.closest\('\[role="menu"\]'\)/);
assert.ok(manifest.permissions.includes("unlimitedStorage"));
const relinkingScript = manifest.content_scripts.find(
  (script) => script.js?.includes("spotify-relinking.js")
);
assert.equal(relinkingScript.world, "MAIN");
assert.equal(relinkingScript.run_at, "document_start");
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

const relinkingContext = vm.createContext({
  CustomEvent: class {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  },
  window: {
    addEventListener() {},
    dispatchEvent() {},
    async fetch() {
      return { url: "" };
    }
  }
});
vm.runInContext(spotifyRelinkingSource, relinkingContext);
const nocturneRelinking = relinkingContext.freshSongsRelinkings({
  data: {
    lookupEntities: [{
      uri: "spotify:track:3frHBWdajaB88CtQFgeMqI",
      typedEntity: {
        data: {
          uri: "spotify:track:3frHBWdajaB88CtQFgeMqI",
          name: "Nocturne",
          artists: {
            items: [{ profile: { name: "Castlevania Sound Team" } }]
          },
          relinkingInformation: {
            linkedTrack: {
              uri: "spotify:track:1gw0wB0sYPf3KX38N6ce6M"
            }
          }
        }
      },
      identityTrait: { name: "夜曲" }
    }]
  }
});
assert.deepEqual(JSON.parse(JSON.stringify(nocturneRelinking)), [{
  sourceId: "3frHBWdajaB88CtQFgeMqI",
  linkedId: "1gw0wB0sYPf3KX38N6ce6M",
  sourceTitle: "Nocturne",
  title: "夜曲",
  artist: "Castlevania Sound Team"
}]);

const relinkingHelpersStart = contentSource.indexOf(
  "function updateTrackRelinkings"
);
const relinkingHelpersEnd = contentSource.indexOf(
  "\nfunction playbackPlaylistTrack",
  relinkingHelpersStart
);
const relinkingHelpers = vm.createContext({
  trackRelinkings: {},
  trackRelinkingTitles: {},
  trackHistoryKey: context.trackHistoryKey
});
vm.runInContext(
  contentSource.slice(relinkingHelpersStart, relinkingHelpersEnd),
  relinkingHelpers
);
relinkingHelpers.updateTrackRelinkings(nocturneRelinking);
assert.equal(
  relinkingHelpers.relinkedTrackTitle(
    "3frHBWdajaB88CtQFgeMqI",
    "Castlevania Sound Team",
    "Nocturne"
  ),
  "夜曲"
);
assert.equal(
  relinkingHelpers.relinkedTrackTitle(
    "",
    "Castlevania Sound Team",
    "Nocturne"
  ),
  "夜曲"
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

const yuiAliases = context.canonicalArtistAliases({
  spotifyArtistId: {
    sourceKey: "yui makino",
    canonicalKey: "牧野由依",
    canonicalName: "牧野由依",
    playcount: 73,
    resolvedAt: 102000,
    url: "https://www.last.fm/music/%E7%89%A7%E9%87%8E%E7%94%B1%E4%BE%9D"
  }
});
assert.equal(yuiAliases.bySource["yui makino"].canonicalKey, "牧野由依");
assert.equal(yuiAliases.byCanonical["牧野由依"].canonicalKey, "牧野由依");

const routedArtistIndex = {
  "牧野由依": { name: "牧野由依", playcount: 73 }
};
context.applyScrobbles(routedArtistIndex, [{
  artist: { "#text": "Yui Makino" },
  date: { uts: "103" }
}], 102, yuiAliases);
assert.equal(routedArtistIndex["牧野由依"].playcount, 74);
assert.equal(routedArtistIndex["yui makino"], undefined);

const missingCanonicalIndex = {};
context.applyScrobbles(missingCanonicalIndex, [{
  artist: { "#text": "Yui Makino" },
  date: { uts: "103" }
}], 102, yuiAliases);
assert.equal(missingCanonicalIndex["牧野由依"].playcount, 74);
assert.equal(missingCanonicalIndex["yui makino"], undefined);

const legacyArtistIndex = {
  "yui makino": {
    name: "Yui Makino",
    playcount: 2,
    lastPlayedAt: 200
  },
  "牧野由依": { name: "牧野由依", playcount: 71 }
};
assert.equal(context.replaceCanonicalArtist(
  legacyArtistIndex,
  "yui makino",
  yuiAliases.bySource["yui makino"],
  {
    artist: {
      name: "牧野由依",
      stats: { userplaycount: "73" },
      url: "https://www.last.fm/music/%E7%89%A7%E9%87%8E%E7%94%B1%E4%BE%9D"
    }
  }
), true);
assert.equal(legacyArtistIndex["yui makino"], undefined);
assert.equal(legacyArtistIndex["牧野由依"].playcount, 73);
assert.equal(legacyArtistIndex["牧野由依"].lastPlayedAt, 200);
assert.equal(context.replaceCanonicalArtist(
  legacyArtistIndex,
  "yui makino",
  yuiAliases.bySource["yui makino"],
  { artist: { stats: { userplaycount: "73" } } }
), false);

const contradictoryArtistIndex = {
  "yui makino": { name: "Yui Makino", playcount: 2 },
  "牧野由依": { name: "牧野由依", playcount: 71 }
};
assert.equal(context.replaceCanonicalArtist(
  contradictoryArtistIndex,
  "yui makino",
  yuiAliases.bySource["yui makino"],
  {
    artist: {
      name: "牧野由依",
      stats: { userplaycount: "0" }
    }
  }
), true);
assert.equal(contradictoryArtistIndex["yui makino"], undefined);
assert.equal(contradictoryArtistIndex["牧野由依"], undefined);

const correctedArtistIndex = {
  "yui makino": { name: "Yui Makino", playcount: 2 },
  "牧野由依": { name: "牧野由依", playcount: 71 }
};
assert.equal(context.replaceCanonicalArtist(
  correctedArtistIndex,
  "yui makino",
  yuiAliases.bySource["yui makino"],
  {
    artist: {
      name: "牧野由依",
      stats: { userplaycount: "70" }
    }
  }
), true);
assert.equal(correctedArtistIndex["yui makino"], undefined);
assert.equal(correctedArtistIndex["牧野由依"].playcount, 70);

const conflictingAliases = context.canonicalArtistAliases({
  first: {
    sourceKey: "Shared Name",
    canonicalKey: "Canonical One",
    canonicalName: "Canonical One"
  },
  second: {
    sourceKey: "Shared Name",
    canonicalKey: "Canonical Two",
    canonicalName: "Canonical Two"
  }
});
assert.equal(conflictingAliases.bySource["shared name"], undefined);

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

const mismatchedTrackKey = context.trackHistoryKey(
  "Aziza Mustafa Zadeh",
  "Bana Bana Gel (Bad Gal)"
);
const mismatchedTrackRequest = context.trackResolutionRequest({
  key: mismatchedTrackKey,
  artist: "Aziza Mustafa Zadeh",
  title: "Bana Bana Gel (Bad Gal)"
});
assert.deepEqual(
  JSON.parse(JSON.stringify(context.trackResolutionFrom({
    track: {
      name: "Bana Bana Gel (Bad Girl)",
      artist: { name: "Aziza Mustafa Zadeh" },
      userplaycount: "20",
      url: "https://www.last.fm/music/Aziza+Mustafa+Zadeh/_/Bana+Bana+Gel+(Bad+Girl)"
    }
  }, mismatchedTrackRequest))),
  {
    sourceKey: mismatchedTrackKey,
    canonicalKey: context.trackHistoryKey(
      "Aziza Mustafa Zadeh",
      "Bana Bana Gel (Bad Girl)"
    ),
    playcount: 20,
    url: "https://www.last.fm/music/Aziza+Mustafa+Zadeh/_/Bana+Bana+Gel+(Bad+Girl)"
  }
);
const resolvedTrack = {
  canonicalKey: context.trackHistoryKey(
    "Aziza Mustafa Zadeh",
    "Bana Bana Gel (Bad Girl)"
  ),
  lastfmUser: "listener",
  playcount: 20,
  url: "https://www.last.fm/music/Aziza+Mustafa+Zadeh/_/Bana+Bana+Gel+(Bad+Girl)"
};
assert.equal(
  context.resolvedTrackRecord(
    mismatchedTrackKey,
    resolvedTrack,
    { playcount: 19 },
    "listener"
  ).playcount,
  20
);
assert.equal(
  context.resolvedTrackRecord(
    mismatchedTrackKey,
    resolvedTrack,
    { playcount: 21 },
    "listener"
  ).playcount,
  21
);
assert.equal(
  context.resolvedTrackRecord(
    mismatchedTrackKey,
    resolvedTrack,
    { playcount: 3 },
    "other-listener"
  ).playcount,
  3
);

const nocturneRequest = context.trackResolutionRequest({
  key: context.trackHistoryKey("Castlevania Sound Team", "Nocturne"),
  artist: "Castlevania Sound Team",
  title: "Nocturne"
});
const nocturneData = {
  track: {
    name: "Nocturne",
    mbid: "9764a214-f09a-4f79-b051-f0e6eaf234eb",
    userplaycount: "0"
  }
};
assert.equal(
  context.trackMbidFallbackTitle(
    nocturneData,
    { track: { name: "夜曲" } },
    nocturneRequest
  ),
  "夜曲"
);
assert.equal(
  context.trackMbidFallbackTitle(
    { track: { ...nocturneData.track, userplaycount: "4" } },
    { track: { name: "夜曲" } },
    nocturneRequest
  ),
  ""
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
assert.equal(canonicalFromIndex.status, "new");
assert.equal(canonicalFromIndex.playcount, 0);

assert.match(
  backgroundSource,
  /replaceCanonicalArtist\(\s*artistIndex,\s*legacyKey,\s*resolution,\s*data/
);

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

const artistDetailsStart = contentSource.indexOf("function artistDetails");
const artistDetailsEnd = contentSource.indexOf(
  "\nfunction resolvedArtistName",
  artistDetailsStart
);
const artistDetailsContext = vm.createContext({
  artistIndex: {
    "yui makino": { name: "Yui Makino", playcount: 2 },
    "牧野由依": { name: "牧野由依", playcount: 73 }
  },
  artistResolutions: {
    spotifyId: {
      sourceKey: "yui makino",
      canonicalName: "牧野由依",
      canonicalKey: "牧野由依",
      playcount: 73,
      url: "https://www.last.fm/music/%E7%89%A7%E9%87%8E%E7%94%B1%E4%BE%9D"
    }
  },
  normalizeArtist: context.normalizeArtist,
  lastFmPageUrl: (value) => value
});
vm.runInContext(
  contentSource.slice(artistDetailsStart, artistDetailsEnd),
  artistDetailsContext
);
const yuiMakino = artistDetailsContext.artistDetails(
  "spotifyId",
  "Yui Makino",
  "yui makino"
);
assert.equal(yuiMakino.canonicalName, "牧野由依");
assert.equal(yuiMakino.playcount, 73);

const canonicalNeededStart = contentSource.indexOf(
  "function canonicalResolutionNeeded"
);
const canonicalNeededEnd = contentSource.indexOf(
  "\nfunction scheduleCanonicalResolution",
  canonicalNeededStart
);
const canonicalNeededContext = vm.createContext({
  artistResolutions: {},
  normalizeArtist: context.normalizeArtist,
  CANONICAL_CACHE_MS: 1_000
});
vm.runInContext(
  contentSource.slice(canonicalNeededStart, canonicalNeededEnd),
  canonicalNeededContext
);
assert.equal(
  canonicalNeededContext.canonicalResolutionNeeded(
    "spotifyId",
    "Yui Makino",
    1_500
  ),
  true
);
canonicalNeededContext.artistResolutions.spotifyId = {
  sourceKey: "yui makino",
  pageStatus: "available",
  resolvedAt: 1_000
};
assert.equal(
  canonicalNeededContext.canonicalResolutionNeeded(
    "spotifyId",
    "Yui Makino",
    1_500
  ),
  false
);
canonicalNeededContext.artistResolutions.spotifyId = {
  sourceKey: "yui makino",
  status: "error",
  retryAfter: 2_000
};
assert.equal(
  canonicalNeededContext.canonicalResolutionNeeded(
    "spotifyId",
    "Yui Makino",
    1_500
  ),
  false
);
assert.match(
  contentSource,
  /!isTrack && canonicalResolutionNeeded\(artistId, name\)/
);

assert.match(contentSource, /"Your plays"/);
assert.match(contentSource, /\/library\/music\/\$\{encodeURIComponent\(name\)\}/);
assert.match(contentSource, /Open in your Last\.fm library/);
assert.match(contentSource, /Last\.fm page unavailable/);
assert.match(contentSource, /hover-or-focus-tooltip/);
assert.match(contentSource, /type:\s*"LOOKUP_TRACKS"/);
assert.match(contentSource, /type:\s*"RESOLVE_TRACK"/);
assert.match(contentSource, /Your track plays/);
assert.match(contentSource, /No Last\.fm history match/);
assert.match(contentSource, /const popoverGap = isTrack \? 0 : 8/);
assert.match(contentSource, /const verticalTargetRect = isTrack/);
assert.match(contentSource, /freshSongsTrackCanonicalKey/);
assert.match(contentSource, /data-fresh-songs-track-new/);
assert.match(contentCss, /\[data-fresh-songs-track-new\]::before/);
assert.doesNotMatch(contentCss, /data-encore-id="text"\]::before/);
assert.match(miniplayerSource, /installFreshArtistPopover\(pipDocument\)/);
assert.match(miniplayerSource, /dataset\.freshSongsTrackKey/);
assert.match(miniplayerSource, /dataset\.freshSongsTrackCanonicalKey/);
assert.match(miniplayerSource, /data-action="meh"/);
assert.doesNotMatch(miniplayerSource, />\s*Meh &amp; skip\s*</);
assert.match(contentSource, /type:\s*"SET_TRACK_MEH"/);
assert.match(contentSource, /data-fresh-songs-meh-skip/);
assert.match(contentSource, /if \(!meh\) FRESH_PLAYER_ACTIONS\.next\(\)\?\.click\(\)/);
assert.match(contentSource, /button\.dataset\.active = String\(meh\)/);
assert.match(contentSource, /mehButton\.textContent = "☹︎"/);
assert.match(contentSource, /Boolean\(pageUrl\) \|\| \(miniplayer && details\.meh\)/);
assert.match(contentSource, /show\(target, \{ x: event\.clientX, y: event\.clientY \}\)/);
assert.match(contentSource, /miniplayer && hoverPoint/);
assert.match(contentSource, /#fresh-songs-player \.fresh-player-timeline/);
assert.match(contentSource, /addEventListener\("pointermove"/);
assert.match(contentSource, /addEventListener\("mouseleave", hide\)/);
assert.match(contentSource, /addEventListener\("blur", hide\)/);
assert.match(contentSource, /popover\.hidden = true/);
assert.match(contentSource, /popover\.hidden = false/);
assert.match(contentSource, /fresh-songs-artist-popover\[hidden\]/);
assert.match(contentSource, /fresh-songs-artist-popover a\[hidden\]/);
assert.match(contentSource, /link\.removeAttribute\("href"\)/);
assert.match(contentSource, /if \(hideTimer !== undefined\) return/);
assert.match(contentSource, /setTimeout\(hide, 80\)/);
assert.match(miniplayerSource, /mehButton\.dataset\.active = String\(meh\)/);
assert.match(miniplayerSource, /button\[data-action="meh"\]\[data-active="true"\]/);
assert.match(miniplayerSource, /fresh-player-track-new/);
assert.match(miniplayerSource, /trackState\?\.status === "new" && !trackState\.meh/);
assert.match(optionsSource, /trackHistoryEnabled/);
assert.match(optionsSource, /navigator\.storage\.estimate\(\)/);
assert.match(optionsSource, /usageDetails\?\.indexedDB/);
assert.match(optionsSource, /type: tracksOnly \? "SYNC_TRACK_HISTORY"/);
assert.match(optionsSource, /const accountChanged/);
assert.match(optionsSource, /const trackHistoryChanged/);
assert.match(optionsSource, /showSaveFilePicker/);
assert.match(optionsHtml, /Connect JSON File/);
assert.match(backgroundSource, /LASTFM_RETRY_DELAYS_MS/);
assert.match(backgroundSource, /type === "SYNC_TRACK_HISTORY"/);
assert.match(backgroundSource, /callLastFm\(settings, "track\.getInfo"/);
assert.match(backgroundSource, /autocorrect:\s*"1"/);
assert.match(backgroundSource, /mbidChecked:\s*true/);
assert.match(backgroundSource, /type === "RESOLVE_TRACK"/);
assert.match(backgroundSource, /type === "SET_TRACK_MEH"/);
assert.match(contentSource, /TRACK_RELINK_EVENT/);
assert.match(contentSource, /relinkedTrackTitle\(trackId, artist\?\.name/);
assert.match(miniplayerSource, /relinkedTrackTitle\(/);
assert.doesNotMatch(
  backgroundSource,
  /settings\.trackHistoryEnabled && !previousMeta\.trackSyncComplete/
);

const syncStorageUpdates = [];
const syncArtistIndex = {
  "yui makino": { name: "Yui Makino", playcount: 2 },
  "牧野由依": { name: "牧野由依", playcount: 71 }
};
const syncArtistResolutions = {
  spotifyArtistId: {
    sourceKey: "yui makino",
    canonicalKey: "牧野由依",
    canonicalName: "牧野由依",
    playcount: 73,
    resolvedAt: 100000
  }
};
context.chrome.storage.local.get = async () => ({
  settings: {
    lastfmUser: "listener",
    apiKey: "test-key",
    trackHistoryEnabled: false
  },
  artistIndex: syncArtistIndex,
  artistResolutions: syncArtistResolutions
});
context.chrome.storage.local.set = async (update) => {
  syncStorageUpdates.push(update);
};
context.fetch = async (url) => ({
  ok: true,
  async json() {
    if (String(url).includes("method=user.getRecentTracks")) {
      return { recenttracks: { track: [], "@attr": { totalPages: "1" } } };
    }
    if (String(url).includes("method=artist.getInfo")) {
      return {
        artist: {
          name: "牧野由依",
          stats: { userplaycount: "73" },
          url: "https://www.last.fm/music/%E7%89%A7%E9%87%8E%E7%94%B1%E4%BE%9D"
        }
      };
    }
    throw new Error(`Unexpected Last.fm request: ${url}`);
  }
});

context.incrementalSync(
  {
    lastfmUser: "listener",
    apiKey: "test-key",
    trackHistoryEnabled: false
  },
  {
    initialSyncComplete: true,
    lastScrobble: 100,
    trackCount: 0,
    trackIndexVersion: 0
  },
  syncArtistIndex,
  syncArtistResolutions
).then(async (syncResult) => {
  assert.equal(syncResult.scrobbles, 0);
  assert.equal(syncResult.migrated, 1);
  const savedIndex = syncStorageUpdates.at(-1).artistIndex;
  assert.equal(savedIndex["yui makino"], undefined);
  assert.equal(savedIndex["牧野由依"].playcount, 73);
  const savedResolution = syncStorageUpdates.at(-1)
    .artistResolutions.spotifyArtistId;
  assert.equal(savedResolution.playcount, 73);
  assert.equal(savedResolution.migrationRetryAfter, 0);

  const coveredIndex = {
    "牧野由依": { name: "牧野由依", playcount: 73 }
  };
  const coveredAt = Math.floor(savedResolution.resolvedAt / 1000);
  const coveredResult = context.applyScrobbles(coveredIndex, [{
    artist: { "#text": "Yui Makino" },
    date: { uts: String(coveredAt) }
  }], coveredAt - 1, context.canonicalArtistAliases({
    spotifyArtistId: savedResolution
  }));
  assert.equal(coveredResult.added, 1);
  assert.equal(coveredIndex["牧野由依"].playcount, 73);
  const canonicalResult = context.applyScrobbles(coveredIndex, [{
    artist: { "#text": "牧野由依" },
    date: { uts: String(coveredAt) }
  }], coveredAt - 1, context.canonicalArtistAliases({
    spotifyArtistId: savedResolution
  }));
  assert.equal(canonicalResult.added, 1);
  assert.equal(coveredIndex["牧野由依"].playcount, 73);
  context.applyScrobbles(coveredIndex, [{
    artist: { "#text": "Yui Makino" },
    date: { uts: String(coveredAt + 1) }
  }], coveredAt, context.canonicalArtistAliases({
    spotifyArtistId: savedResolution
  }));
  assert.equal(coveredIndex["牧野由依"].playcount, 74);

  syncStorageUpdates.length = 0;
  const failedMigrationIndex = {
    "yui makino": { name: "Yui Makino", playcount: 2 },
    "牧野由依": { name: "牧野由依", playcount: 71 }
  };
  context.fetch = async (url) => ({
    ok: true,
    async json() {
      if (String(url).includes("method=user.getRecentTracks")) {
        return {
          recenttracks: { track: [], "@attr": { totalPages: "1" } }
        };
      }
      return { error: 6, message: "Artist not found" };
    }
  });
  const failedMigration = await context.incrementalSync(
    {
      lastfmUser: "listener",
      apiKey: "test-key",
      trackHistoryEnabled: false
    },
    {
      initialSyncComplete: true,
      lastScrobble: 100,
      trackCount: 0,
      trackIndexVersion: 0
    },
    failedMigrationIndex,
    syncArtistResolutions
  );
  assert.equal(failedMigration.migrated, 0);
  assert.equal(failedMigrationIndex["yui makino"].playcount, 2);
  assert.ok(
    syncStorageUpdates.at(-1)
      .artistResolutions.spotifyArtistId.migrationRetryAfter > Date.now()
  );
  console.log("Fresh Songs checks passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
