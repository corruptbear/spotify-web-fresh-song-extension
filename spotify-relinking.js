function freshSongsSpotifyTrackId(uri) {
  return String(uri || "").match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] || "";
}

function freshSongsRelinkings(data) {
  const mappings = [];
  for (const entity of data?.data?.lookupEntities || []) {
    const track = entity?.typedEntity?.data;
    if (
      !track ||
      !Object.prototype.hasOwnProperty.call(track, "relinkingInformation")
    ) continue;

    const sourceId = freshSongsSpotifyTrackId(entity.uri || track.uri);
    const linkedId = freshSongsSpotifyTrackId(
      track.relinkingInformation?.linkedTrack?.uri
    );
    if (!sourceId) continue;

    mappings.push({
      sourceId,
      linkedId,
      sourceTitle: String(track.name || "").trim(),
      title: String(entity.identityTrait?.name || track.name || "").trim(),
      artist: String(
        track.artists?.items?.[0]?.profile?.name || ""
      ).trim()
    });
  }
  return mappings;
}

(() => {
  const RESPONSE_EVENT = "fresh-songs-relinkings";
  const REQUEST_EVENT = "fresh-songs-request-relinkings";
  const relinkings = new Map();
  const originalFetch = window.fetch.bind(window);

  function emit() {
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify([...relinkings.values()])
    }));
  }

  function update(data) {
    let changed = false;
    for (const mapping of freshSongsRelinkings(data)) {
      if (
        mapping.linkedId &&
        mapping.linkedId !== mapping.sourceId &&
        mapping.title
      ) {
        const previous = relinkings.get(mapping.sourceId);
        if (JSON.stringify(previous) !== JSON.stringify(mapping)) {
          relinkings.set(mapping.sourceId, mapping);
          changed = true;
        }
      } else if (relinkings.delete(mapping.sourceId)) {
        changed = true;
      }
    }
    if (changed) emit();
  }

  window.fetch = (...args) => {
    const response = originalFetch(...args);
    response.then((result) => {
      if (!String(result.url).startsWith(
        "https://api-partner.spotify.com/pathfinder/"
      )) return;
      result.clone().json().then(update).catch(() => {});
    }).catch(() => {});
    return response;
  };

  window.addEventListener(REQUEST_EVENT, emit);
})();
