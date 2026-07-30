# Draft Cockpit

An offline-first, single-screen fantasy football draft cockpit. Hand-written vanilla JavaScript, zero build step, zero dependencies, zero backend. It runs entirely as static files; all draft state (rankings, marks, undo history, filters) lives in the browser's localStorage on the device you draft from.

## Quick start (dev)

**Option A: just open it.** Double-click `index.html`. Everything works over `file://` except the service worker (offline caching needs `http://`/`https://`).

**Option B: full PWA behavior (service worker, offline test).**

```powershell
powershell -File scripts\serve.ps1
```

Then open http://localhost:8321/ in a browser. Ctrl+C stops the server. If port 8321 is already bound, the script falls back to `http://127.0.0.1:8321/` automatically.

## Run the tests

```powershell
powershell -File scripts\run-tests.ps1
```

This drives headless Chrome (falls back to Edge if Chrome isn't installed) against `tests.html` and prints a `TESTS: N passed, M failed` line, exiting 1 on any failure. You can also just open `tests.html` directly in a browser to see the same results rendered on the page.

The harness is fail-closed: if the page crashes or a test section never registers, the script reports an error and exits 1 rather than silently reporting 0 failures.

## Deploy to GitHub Pages (one-time, about 5 minutes)

1. Create a new empty repository on github.com (public, do not initialize it with a README).
2. Add it as a remote and push:

```powershell
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

   The first push opens a browser sign-in via Git Credential Manager. No admin rights needed.

3. On the repo's GitHub page, go to Settings -> Pages.
4. Under "Build and deployment", set Source to "Deploy from a branch", Branch to `main`, folder to `/ (root)`. Save.
5. Wait about a minute, then open `https://<you>.github.io/<repo>/`.

Every path in this app is relative (`./index.html`, `./sw.js`, etc.), so it works correctly at that repo subpath with no configuration changes. The repo must serve from the branch root; no `/docs` folder is needed.

## Install on iPhone

1. Open the GitHub Pages URL in **Safari** (must be Safari, not Chrome or another browser).
2. Tap Share -> Add to Home Screen.
3. Launch the app from its home screen icon. It runs standalone and fullscreen, not inside Safari's browser chrome.

**Offline:** after the first online open, the app works with zero connectivity. Airplane Mode is a good way to test this.

**Updates:** redeploying requires bumping `CACHE_NAME` in `sw.js` (see the comment at the top of that file). An installed app picks up a new version on the *second* online open after a redeploy, not the first. This is expected iOS service-worker behavior, not a bug.

## Import your real rankings

Open Settings -> Import Rankings, then paste text into the box or choose a file (`.csv`, `.txt`, `.tsv`, `.json` are accepted), and tap Parse. Review the preview, then tap "Replace rankings" to apply it.

Supported rankings formats:

- **FantasyPros-style CSV export**, header row plus data rows, e.g.:

  ```
  RK,PLAYER NAME,TEAM,POS,BYE
  1,Christian McCaffrey,SF,RB,9
  ```

  Recognized header names: `RK`/`RANK`, `PLAYER`/`PLAYER NAME`/`NAME`, `TEAM`, `POS`/`POSITION`, `BYE`/`BYE WEEK`. Any header row with at least 2 of these is treated as a header; TSV (tab-separated) works the same way.

- **Numbered or plain list**, one player per line:

  ```
  1. Christian McCaffrey SF RB
  ```

- **Parenthesized team/position**:

  ```
  Josh Allen (BUF - QB)
  ```

A line needs a recognizable position token to parse at all; name-only lines (no team, no position) are skipped with a warning because there's nothing to classify them by. K and DST/DEF rows are skipped by design, this app only tracks QB/RB/WR/TE. Rank order comes from the order rows appear in the file (top to bottom), not from any rank number in the file.

To export from FantasyPros: go to your Rankings page -> Export -> CSV, then paste the downloaded file's contents into the Import box (or upload the file directly).

Re-importing preserves your Drafted/Target/Avoid marks for any player whose name and team match a player in the new file. Players that drop out of the new file lose their marks; new players start Available.

## Backup / restore

Settings -> Export Backup downloads a `draft-cockpit-backup.json` file containing your full state (rankings, marks, undo history, filters). To restore, paste or upload that same file into the Import box (Settings -> Import Rankings); it's auto-detected as a backup rather than a rankings file.

**Export a backup before draft day, and again right after the draft.** localStorage is the only copy of your data; there is no cloud sync.

## Updating your rankings later

Re-import at any time via Settings -> Import Rankings using any of the supported formats above. The board re-ranks instantly and your existing marks carry over for matching players.

## Project layout

```
draft-cockpit/
  index.html              app shell; loads scripts in dependency order (data -> state -> importer -> ui -> app)
  styles.css              all styling (dark theme, safe-area insets)
  manifest.webmanifest    PWA manifest (icons, standalone display, start_url/scope "./")
  sw.js                   service worker: cache-first offline support; bump CACHE_NAME on any precached file change
  tests.html              in-browser unit test harness (open directly, or run headless via scripts\run-tests.ps1)
  js/
    data.js               seed player data (252 players), team bye weeks, id slugging
    state.js              state shape, reducer, localStorage load/save, schema migrations
    importer.js           rankings + backup file parsing (CSV/TSV/list/parenthesized/backup JSON)
    ui.js                 all rendering and event wiring (search, filters, undo, settings sheet)
    app.js                entry point: creates the store, mounts the UI, registers the service worker
  icons/
    icon-192.png            PWA icon, 192x192
    icon-512.png            PWA icon, 512x512 (maskable)
    apple-touch-icon.png    iOS home-screen icon, 180x180
  scripts/
    serve.ps1              local dev server (HttpListener on localhost:8321, no admin needed)
    run-tests.ps1          headless-Chrome/Edge test runner (fail-closed: crash counts as failure)
    make-icons.ps1         regenerates the three icon PNGs via System.Drawing
```

## Regenerating icons

Only needed if you change the icon design.

```powershell
powershell -File scripts\make-icons.ps1
```

This writes `icon-512.png`, `icon-192.png`, and `apple-touch-icon.png` into `icons/`.
