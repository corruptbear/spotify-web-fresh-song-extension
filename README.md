# Fresh Songs

Chrome extension that marks Spotify Web artists missing from your Last.fm
listening history.

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

- The first sync reads `library.getArtists`.
- Later syncs read `user.getRecentTracks` once per minute.
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

## Check

```sh
node --check artist-names.js
node --check background.js
node --check content.js
node --check options.js
node test.js
```
