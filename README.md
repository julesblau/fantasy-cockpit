# Draft Cockpit

An offline-first, single-screen fantasy football draft cockpit. Hand-written vanilla JavaScript, zero build step, zero dependencies, zero backend. It runs entirely as static files; all draft state (rankings, marks, undo history, filters) lives in the browser's localStorage on the device you draft from.

## Quick start (dev)

**Option A: just open it.** Double-click `index.html`. Everything works over `file://` except the service worker (offline caching needs `http://`/`https://`).

**Option B: full PWA behavior (service worker, offline test).**

```powershell
powershell -File scripts\serve.ps1
```

Then open http://localhost:8321/ in a browser. Ctrl+C stops the server. If binding `http://localhost:8321/` fails with an access-denied/URL-ACL error, the script falls back to `http://127.0.0.1:8321/` automatically; a genuine port conflict (something else already using 8321) instead needs the `$port` variable in `serve.ps1` changed.

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

**Reminder for this release:** this release bumps the service-worker cache to v4. Already-installed iPhones pick up the update on their SECOND online open after you deploy, not the first -- that's expected iOS service-worker behavior, not a bug.

## Install on iPhone

1. Open the GitHub Pages URL in **Safari** (must be Safari, not Chrome or another browser).
2. Tap Share -> Add to Home Screen.
3. Launch the app from its home screen icon. It runs standalone and fullscreen, not inside Safari's browser chrome.
4. Verify Export downloads on the phone (Settings -> Export Backup). See the iOS note under Backup/restore below if the download prompt doesn't appear.

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

Once you've manually reordered your rankings (see Edit your rankings in-app, below), Import Rankings automatically downloads a backup file before replacing the board with the imported one. See the iOS standalone note under Backup/restore if the download prompt doesn't appear.

The board itself is the single source of truth for every feature above and below this section -- ranks, tiers, marks, all of it. A planned future import mode will let you blend multiple ranking and tier sources (say, two different analysts' rankings files) into one board at import time. Because tier dividers, quiet signals, and roster needs all read straight off the board, a blended import will need no other changes to reach every one of them at once.

## Edit your rankings in-app

Open Settings -> Edit Rankings to reorder the board by hand, without re-importing a file. Drag a row's handle to move a player, or tap a player's rank number to type an exact rank and jump straight there. Tap Done to commit your changes to the board, or Cancel to discard them; Cancel asks for confirmation first if you've moved anyone. Drafted players show their DRAFTED badge in the editor and can still be dragged or rank-jumped like anyone else. Searching inside edit mode is for finding a player: dragging is disabled while a search filter is active, but tapping a player's rank number to jump still works.

Tap a position chip (All/QB/RB/WR/TE) above the list to scope the editor to one position. Ranks then display position-scoped, with the overall rank alongside -- e.g. `RB1  #14` -- and the rank-jump card asks for a position rank instead of an overall one ("Move Bijan Robinson to RB rank"). Dragging still works while a position chip is active; only an active text search pauses dragging, a position filter never does.

Manual edits persist until your next Import Rankings.

## Tiers

Tiers group the board into named bands (Tier 1, Tier 2, ...). Import a header-based rankings file (FantasyPros-style CSV/TSV) with a `TIERS` or `TIER` column and tiers come in automatically; the headerless formats (numbered list, plain list, parenthesized team/position) have no column to read a tier from, so those players import untiered. However the source file orders its tier values, the app forces them into non-decreasing order down the board on import, correcting anything out of order in the file itself.

A divider line marks every tier break, everywhere a tiered player can appear -- the Available list, the Drafted list, and the Edit Rankings editor all use the same rule.

Inside Edit Rankings, tap a player's rank to open the rank-jump card; it always includes a Tier -/+ stepper. The stepper is bounded by the nearest tiered players above and below in board order -- untiered rows in between don't constrain it -- so a tier can never be stepped out of order relative to its neighbors; stepping below the floor clears the tier to none when nothing above it is tiered at all.

Dragging a player across a tier boundary re-tiers him automatically to stay consistent with his new neighbors -- you don't need to touch the stepper for a plain reorder.

## Track your own roster

While drafting, mark which picks are yours as you go.

- **Tap DRAFT** normally to record someone else's pick -- unchanged from before.
- **Long-press DRAFT** (about half a second -- the button fills blue while you hold) to mark that pick as yours instead.
- Tap the **Mine** chip to filter the board down to your picks. In place of the usual filter summary line, it shows a roster summary: your QB/RB/WR/TE counts and total picks.
- Made a mistake? In the Drafted or Mine view, tap the person icon on any pick to toggle whether it's yours, no need to undo and redraft.

Without a league set up (see Draft position tracker, below), the Mine summary is just position counts: a QB/RB/WR/TE total for each position plus your total pick count.

Set a roster template in Settings -> League -- steppers for QB, RB, WR, TE, FLEX, and Bench slot counts, alongside the league size/slot/snake settings. Once a template is set, the Mine summary switches to filled-vs-required for each of QB, RB, WR, TE, and FLEX, plus a plain filled count for Bench. Each of your picks fills its own position's slots first; once those are full, an RB/WR/TE pick rolls into FLEX if there's room, otherwise it counts as Bench. Picks are counted in the order you drafted them, so backfilling marks out of draft order can shuffle which slot a given pick lands in.

## Draft position tracker

Set up your league in Settings -> League: league size, your draft slot, and snake vs. linear draft order (a "Set up draft tracker" button appears there if you haven't configured one yet). Once set, a tracker strip appears under the position-counts row at the top of the screen, showing the current round, the current overall pick, and how many picks remain until you're on the clock -- or "You're up" when it's your pick right now.

The tracker has no separate "record a pick" step: it derives round/pick/picks-until-you entirely from a count of how many players are marked Drafted on the board. Forgetting to mark a pick drifts the tracker out of sync with the real draft, so keep every pick logged as it happens.

Tap "Clear league setup" in Settings -> League to remove your league config. The tracker strip and the GONE SOON signal below disappear, and the roster-needs summary above reverts to the plain position-counts line, until you set league config up again.

## Quiet signals

Small tags that can appear next to an available player's name. They're passive markers, never suggestions on who to draft; at most two show per player, in this priority order:

- **VALUE** -- still on the board 10+ picks past his own rank (and ranked 100 or better). Works with no league setup.
- **CLIFF** -- the last available player left in his tier at his position. Also works with no league setup.
- **GONE SOON** -- one of the next N available players in board order, where N is how many picks stand between the current pick and your next one. Needs a league set up (see Draft position tracker, above); VALUE and CLIFF do not, so GONE SOON is the one signal that goes silent without league config while the other two keep working.

## Backup / restore

Settings -> Export Backup downloads a `draft-cockpit-backup.json` file containing your full state (rankings, marks, undo history, filters). To restore, paste or upload that same file into the Import box (Settings -> Import Rankings); it's auto-detected as a backup rather than a rankings file.

**Export a backup before draft day, and again right after the draft.** localStorage is the only copy of your data; there is no cloud sync.

**iOS standalone note:** if you installed the app to your home screen and the Export download prompt doesn't appear when you tap it, open the app's URL in Safari itself (not the home-screen icon) and export from there instead. This is a limitation of anchor-tag downloads inside an iOS standalone (home-screen) web app, not a bug in the app.

## Updating your rankings later

Re-import at any time via Settings -> Import Rankings using any of the supported formats above. The board re-ranks instantly and your existing marks carry over for matching players.

## Project layout

```
draft-cockpit/
  index.html              app shell; loads scripts in dependency order (data -> state -> importer -> ui -> edit -> app)
  styles.css              all styling (dark theme, safe-area insets)
  manifest.webmanifest    PWA manifest (icons, standalone display, start_url/scope "./")
  sw.js                   service worker: cache-first offline support; bump CACHE_NAME on any precached file change
  tests.html              in-browser unit test harness (open directly, or run headless via scripts\run-tests.ps1)
  js/
    data.js               seed player data (252 players), team bye weeks, id slugging
    state.js              state shape, reducer, localStorage load/save, schema migrations
    importer.js           rankings + backup file parsing (CSV/TSV/list/parenthesized/backup JSON)
    ui.js                 all rendering and event wiring (search, filters, undo, settings sheet)
    edit.js               drag-to-reorder / tap-to-jump rankings editor (Settings -> Edit Rankings)
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

## App Store, later (optional)

This is entirely optional and outside this project's zero-toolchain, zero-dependency philosophy. The app already installs like a native app via Add to Home Screen (see Install on iPhone, above); nothing below is required for that to work.

If you ever want an actual App Store / Play Store listing:

- **Capacitor** (capacitorjs.com) can wrap this static tree as-is into an Xcode / Android Studio project: `npx cap init`, then `npx cap add ios` (or `android`). This requires Node -- deliberately not part of this repo's normal workflow, but fine to run from a separate machine that has Node when the time comes.
- **iOS submission** requires Xcode, which requires a Mac, plus an Apple Developer Program membership ($99/yr). From a Windows machine, the realistic path is a cloud-Mac build service (Codemagic, Ionic Appflow, GitHub-hosted macOS runners).
- **PWABuilder** (pwabuilder.com) reads this app's existing manifest and service worker and can package it for the Microsoft Store or Android with less friction than Capacitor. Its iOS path still ends at Xcode/a Mac for signing.
