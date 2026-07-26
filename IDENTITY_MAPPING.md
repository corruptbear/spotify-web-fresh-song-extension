# Spotify ↔ Last.fm Identity Mapping Notes

This note records the subtle relationships among artists, tracks, Spotify
relinking, Last.fm canonical names, and personal play counts encountered while
developing Fresh Songs. Its purpose is to prevent us from confusing “the same
recording,” “the same Spotify item,” and “the same Last.fm history entry.”

## The Most Important Invariant

Fresh Songs must display the current user's `userplaycount` from the exact
Last.fm `artist + track` entry that receives the scrobble. Spotify popularity,
public Last.fm statistics, and related titles or versions are not substitutes.

## Four Different Kinds of Identity

A seemingly simple song can have four identities at once:

1. **Spotify page item:** identified by a 22-character Spotify track ID.
2. **Spotify actual playback item:** possibly a relinked version of the page
   item.
3. **MusicBrainz recording:** possibly identified by an MBID.
4. **Last.fm personal history entry:** primarily identified by artist and track
   strings.

These are not one-to-one relationships.

```text
Spotify playlist track ID
          │
          ├─ market/license relinking may occur
          ▼
Spotify actual playable track
          │
          ├─ scrobbler submits artist/title/possibly an external identifier
          ▼
Last.fm artist + track history bucket
```

## Spotify Track Relinking

Spotify's catalog often contains multiple track IDs for the same recording,
such as regional, label, album-edition, and reissue variants. When the original
track is unavailable in the user's market, Spotify may play another available
item. This is called Track Relinking:

<https://developer.spotify.com/documentation/web-api/concepts/track-relinking>

Important details:

- A playlist or page URL can retain the original track ID.
- The visible title can retain the original item's name.
- The artwork, underlying metadata, or actual playable resource may come from
  the relinked item.
- `relinkingInformation: null` means Spotify explicitly supplied no linked
  track for that entity.
- A response that omits the field entirely does not prove that no relinking
  exists.
- Relinking depends on the user's market, licensing state, and product
  restrictions. It is not a permanent global fact.

The DOM, address bar, Media Session title, and oEmbed title are therefore not
sufficient by themselves to establish the actual playback identity.

### `Nocturne` / `夜曲` Example

The original Spotify item shown in the page and playlist is:

```text
spotify:track:3frHBWdajaB88CtQFgeMqI
title: Nocturne
```

For the current account and market, Spotify Web returned:

```text
relinkingInformation.linkedTrack.uri:
spotify:track:1gw0wB0sYPf3KX38N6ce6M

identityTrait.name:
夜曲
```

Another item, `4LlMaHccNSeI7yeXb2mhgF / 夜曲`, is also a catalog copy of the
same audio, but it was not the linked track specified by this response. Audio
equivalence therefore does not prove that an item is the current relink target.

The page URL and now-playing text still showed `Nocturne`, while some artwork
and lower-level metadata came from the Japanese item. Only Spotify Web's
internal `lookupEntities` response explicitly exposed both
`relinkingInformation` and `identityTrait`.

## Current Relinking Implementation

`spotify-relinking.js` runs in the page's main world at `document_start`. It
observes the `api-partner.spotify.com/pathfinder/` fetch responses Spotify is
already making. It does not make additional Spotify API requests and does not
require Spotify OAuth.

The flow is:

1. Read `data.lookupEntities`.
2. Find `typedEntity.data.relinkingInformation`.
3. Record the source Spotify ID, linked Spotify ID, page title, and
   `identityTrait.name`.
4. Pass the JSON string to the isolated content script through a DOM event.
5. Prefer the relinked title when constructing a Last.fm lookup key for a track
   row.
6. When the miniplayer cannot obtain the current track ID directly, use a
   conflict-free mapping from `first artist + displayed title` observed within
   that page.

Relinking mappings currently live only in page memory and are not persisted.
This prevents a mapping from surviving after the user's market or Spotify's
catalog changes. Each Spotify tab builds mappings from the responses it
actually receives.

### Current Limitations

- Spotify's internal GraphQL schema is not a stable public extension API and
  its fields may change.
- Not every page or GraphQL operation returns `lookupEntities`.
- Some tracks simply have no relinking.
- If a page provides no relinking data, the extension cannot derive another
  catalog item from the Spotify ID alone.
- Matching preview URLs, durations, artists, or artwork can suggest the same
  recording, but cannot prove which item Spotify selected as the linked track.

## Last.fm Track Identity

Personal Last.fm track history is still effectively organized around:

```text
first artist string + track title string
```

The following pages can therefore have separate personal play counts:

```text
Castlevania Sound Team + Nocturne
Castlevania Sound Team + 夜曲
```

The page with the larger public statistics does not automatically become the
destination for a user's scrobbles.

Fresh Songs follows Spotify/Last.fm scrobbling behavior and uses only the first
artist in a Spotify row when constructing a track-history key. It does not try
every credited artist as a separate Last.fm track identity.

## What an MBID Is—and Is Not

An MBID is a MusicBrainz Identifier, normally a UUID that identifies an artist,
recording, release, or another MusicBrainz entity.

An MBID:

- is not a Spotify track ID;
- is not an audio fingerprint calculated during playback;
- is not available for every Last.fm track;
- can be absent, incorrect, merged as a duplicate, or redirected from an old
  ID to a new one;
- can help identify one recording behind different titles, but cannot by itself
  determine which string-based Last.fm entry received the user's scrobble.

`track.getInfo` never receives a Spotify URL or track ID. Its title argument
depends on whether Fresh Songs observed a relinking response:

```text
Relinking available:
Spotify source item: Nocturne
→ effective title: 夜曲
→ Last.fm track.getInfo(Castlevania Sound Team, 夜曲)
→ userplaycount: 4
```

If no relinking response is available, the extension starts with the title
displayed by the source Spotify item and can use the MBID fallback:

```text
Last.fm track.getInfo(Castlevania Sound Team, Nocturne)
→ userplaycount: 0
→ returns an MBID

Query Last.fm by that MBID
→ canonical recording title: 夜曲

Last.fm track.getInfo(Castlevania Sound Team, 夜曲)
→ userplaycount: 4
→ correct personal-history page
```

The `Nocturne` query therefore belongs to the no-relinking fallback path. The
MBID is mapping evidence, not the source of the play count.

## Canonicalization Process

Canonicalization is not translation, romanization, or fuzzy guessing. It asks
Last.fm which official entry corresponds to a name obtained from Spotify.

### Artist Canonicalization

Examples:

```text
Ichiko Hashimoto → 橋本一子
SEATBELTS        → The Seabelts
Yui Makino       → 牧野由依
```

The normal resolution path is:

```text
Spotify artist ID + Spotify display name
                │
                ├─ NFKC, trim, collapse whitespace, lowercase
                ▼
Last.fm artist.getInfo(
  artist = Spotify display name,
  username = current user,
  autocorrect = 1
)
                │
                ▼
Last.fm canonical artist name, URL, and userplaycount
                │
                ▼
Spotify artist ID → Last.fm canonical artist identity
```

The exact rules are:

1. Read the stable Spotify artist ID from the artist link and the display name
   currently shown by Spotify.
2. Normalize the name only to remove Unicode-form, capitalization, and excess
   whitespace differences.
3. Call Last.fm `artist.getInfo` with the original Spotify display name, the
   current username, and `autocorrect=1`.
4. Treat `artist.name` in the Last.fm response as the canonical name. The
   extension does not translate an English name into Japanese or choose an
   artist using string similarity.
5. Store the mapping with the Spotify artist ID as its entry point. Using an ID
   instead of only a display name prevents different Spotify artists with the
   same name from sharing a result.
6. Determine heard/new status and the tooltip count from
   `artist.stats.userplaycount`. This is specific to the current Last.fm user;
   public scrobble totals cannot replace it.
7. Treat the URL returned by Last.fm as evidence for the canonical page. Build
   the user's Last.fm library link from the canonical name rather than the
   Spotify alias.

The code also contains a very small list of manually verified aliases, such as
`Ichiko Hashimoto → 橋本一子`. It is only a fast normalization path for known
names, not the general canonicalization mechanism. Unknown artists must still
follow the identity returned by Last.fm.

### Track Canonicalization

A track must resolve its title as well as its artist:

```text
Spotify first artist + effective track title
                │
                ├─ normalize artist/title formatting
                ▼
Last.fm track.getInfo(artist, track, username, autocorrect=1)
                │
                ▼
Last.fm canonical artist, canonical title, URL, and userplaycount
```

The order is:

1. If Spotify's current response provides relinking, first use the linked
   track's effective title; otherwise use the page's track title.
2. Use only Spotify's first artist, because Spotify's Last.fm scrobbles normally
   file the track under that artist.
3. Query the local Last.fm history with `first artist + title`. If there is no
   exact record, call `track.getInfo` with `autocorrect=1`.
4. Combine `track.artist` and `track.name` from the Last.fm response into the
   canonical track key. The returned `userplaycount` and URL belong to that key.
5. If the exact query reports zero but supplies an MBID, query Last.fm for the
   recording identity and then make an exact query for the resulting alternate
   title. The MBID only helps find the canonical title; the final count still
   comes from that artist/title entry's `userplaycount`.

Artist canonicalization and Spotify track relinking are separate operations.
Relinking first answers “which track did Spotify actually provide?”
Canonicalization then answers “which Last.fm entry contains this artist/title?”
Both operations can occur for the same song.

## Current Track-Decision Priority

From strongest to weakest:

1. **Spotify's current `relinkingInformation + identityTrait` response**
2. **An exact local Last.fm history match for the effective artist/title**
3. **The `userplaycount` from Last.fm `track.getInfo` for that artist/title**
4. **The Last.fm MBID alternate-title fallback**
5. **The original Spotify first artist + displayed title**

Spotify popularity, public Last.fm scrobble totals, and hand-written
translation heuristics are not part of the decision chain.

## Local Synchronization and Storage

### `chrome.storage.local`

The main records are:

- settings;
- artistIndex;
- artistResolutions;
- trackResolutions;
- syncMeta;
- mehTracks.

The extension has the `unlimitedStorage` permission. Meh data can be exported
to a separate JSON file so it survives moving to another computer or removing
the extension.

### IndexedDB

The compact full-track-history index is stored in IndexedDB under the extension
origin:

```text
database: fresh-songs
store: tracks
key: normalized first artist + separator + normalized track title
```

When track history is first enabled, Fresh Songs reads the paginated Last.fm
`user.getTopTracks` history. Subsequent background synchronization uses
`user.getRecentTracks` once per minute for incremental updates. Opening or
scrolling a long playlist only makes batched local-index queries; it does not
call the Last.fm API for every row.

## Multiple Tabs and Updates

- One Chrome MV3 background service worker is shared by all Spotify tabs.
- Last.fm background synchronization runs once, not once per open tab.
- Each content script is responsible only for annotating its own DOM.
- A hidden page does not need to scan its full DOM continuously; it refreshes
  its annotations when it becomes visible again.
- `chrome.storage.onChanged` distributes shared history and resolution results
  to the tabs.
- Relinking-response interception is local to each page because it represents
  the Spotify market resolution that page actually received.

## Scrobble Timing and the Final Source of Truth

Fresh Songs neither writes scrobbles nor decides how long Spotify/Last.fm waits
before submitting one. It reads the latest Last.fm history once per minute. A
track skipped before reaching the scrobble threshold will normally not appear
in that history.

The most authoritative possible future improvement would be to associate every
new recent Last.fm track with the Spotify track ID playing at that moment:

```text
Spotify source/linked track ID
→ actual Last.fm artist + track key + URL
```

An observed scrobble could then supersede a title inferred through relinking or
an MBID. Before such a scrobble is observed, however, a page that exposes no
relinking data and a Last.fm entry with no MBID do not provide enough evidence
to guarantee which string-based Last.fm entry will receive the play.

## Maintenance Checklist

When a track play count or link is wrong, inspect the following in order:

1. What is the source Spotify track ID in the row?
2. Did the current page return `relinkingInformation`?
3. What are `linkedTrack.uri` and `identityTrait.name`?
4. Do the Spotify UI, Media Session, artwork, and internal metadata disagree?
5. What `userplaycount` and URL does Last.fm return for the exact source
   artist/title?
6. What does the exact relinked artist/title query return?
7. Do the two Last.fm pages contain separate personal histories?
8. Is an MBID present, and does it lead through a canonical redirect or merge?
9. Did the extension obtain its displayed number from the same Last.fm page it
   links to?
10. Do not hide an unresolved mapping behind public popularity, audio
    equivalence, or a translation guess.
