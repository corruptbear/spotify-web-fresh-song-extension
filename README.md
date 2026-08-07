# Fresh Songs

Chrome extension that marks Spotify Web artists missing from your Last.fm
listening history, shows lifetime track play counts, and enables Spotify
podcast transcript sync and export.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Click the Fresh Songs toolbar icon.
5. Enter your Last.fm username and API key, then wait for the first sync.
6. Open or reload <https://open.spotify.com/>.

Create a Last.fm API account at <https://www.last.fm/api/account/create>.
Only the API key is needed; do not enter the shared secret.

## How it works

### Last.fm listening history

- The first sync reads `library.getArtists`.
- Optional track history reads the paginated `user.getTopTracks` chart once
  and stores its compact index in extension IndexedDB.
- Later syncs read `user.getRecentTracks` once per minute.
- Visible Spotify track titles query that local index in batches; opening or
  scrolling a playlist does not make per-track Last.fm requests.
- Unmatched visible Spotify artists are resolved through
  `artist.getInfo&autocorrect=1`; `NEW` appears only after Last.fm confirms
  that the user's canonical artist play count is zero.
- Artist names, play counts, and the last sync cursor stay in
  `chrome.storage.local`.
- The extension sends no data anywhere except Last.fm and does not write
  scrobbles.

`NEW` means Last.fm resolved the Spotify name to its canonical artist and
reported a user play count of zero. A small explicit alias list in
`artist-names.js` remains as a fast fallback for verified cross-service names.

See [IDENTITY_MAPPING.md](IDENTITY_MAPPING.md) for the subtle differences
between Spotify track IDs, relinking, MBIDs, and Last.fm history entries.

### Podcast transcripts

For episodes where Spotify provides a **Transcript** tab, the extension:

- follows playback automatically and highlights every paragraph belonging to
  the current timestamp in green;
- keeps transcript text selectable, uses the browser's normal selection
  appearance, displays it at 15px, and removes artificial spacing from
  Japanese text; and
- adds a copy icon beside the active **Transcript** tab. One click copies the
  complete transcript as plain text, grouped by timestamp with speaker names
  and all associated paragraphs.

## Check

```sh
node --check artist-names.js
node --check background.js
node --check content.js
node --check miniplayer.js
node --check options.js
node test.js
```

## Release

Pushing a three-part version tag runs the checks, packages the extension, and
attaches `fresh-songs-v0.2.0.zip` to a new GitHub Release. The tag supplies the
packaged extension version; `manifest.json` in the repository is not changed.

```sh
git add .
git commit -m "prepare release"
git push origin main

git tag v0.2.0
git push origin v0.2.0
```
