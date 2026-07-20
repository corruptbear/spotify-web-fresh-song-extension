// ponytail: keep verified cross-service aliases explicit; add editable aliases
// when this list stops being small.
const ARTIST_ALIASES = Object.freeze({
  "ichiko hashimoto": "橋本一子",
  "seatbelts": "the seatbelts"
});

function normalizeArtist(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function artistHistoryKey(name) {
  const normalized = normalizeArtist(name);
  return ARTIST_ALIASES[normalized] || normalized;
}

function spotifyArtistId(href) {
  return String(href || "").match(
    /^\/artist\/([A-Za-z0-9]{22})\/?(?:[?#].*)?$/
  )?.[1] || "";
}
