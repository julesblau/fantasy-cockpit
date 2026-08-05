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

**Reminder for this release:** upgrading from an older version resets your league's roster template to the new QB/RB/WR/TE/FLEX/DST/K/Bench default on first load -- league size, draft slot, and snake setting are all kept, only the roster slot counts reset. If you'd customized the steppers, re-tune them in Settings -> League after upgrading. This release also bumps the service-worker cache to v10. Already-installed iPhones pick up the update on their SECOND online open after you deploy, not the first -- that's expected iOS service-worker behavior, not a bug.

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

A line needs a recognizable position token to parse at all; name-only lines (no team, no position) are skipped with a warning because there's nothing to classify them by. Kickers and team defenses import as their own positions, K and DST -- DEF and D/ST both normalize to DST, so either spelling is recognized whether it comes from a header-based POS/TEAM column or a headerless token. In a headerless line like `49ers D/ST SF`, the D/ST token is read as the position and the name becomes just "49ers"; column-based files keep whatever full name text sits in the PLAYER column untouched. Rows whose position token isn't recognized at all are genuinely skipped, and the import preview reports how many. Rank order comes from the order rows appear in the file (top to bottom), not from any rank number in the file.

To export from FantasyPros: go to your Rankings page -> Export -> CSV, then paste the downloaded file's contents into the Import box (or upload the file directly).

Re-importing preserves your Drafted/Target/Avoid marks for any player whose name and team match a player in the new file. Players that drop out of the new file lose their marks; new players start Available.

Once you've manually reordered your rankings (see Edit your rankings in-app, below), Import Rankings automatically downloads a backup file before replacing the board with the imported one. See the iOS standalone note under Backup/restore if the download prompt doesn't appear.

The board itself is the single source of truth for every feature above and below this section -- ranks, tiers, marks, all of it. A planned future import mode will let you blend multiple ranking and tier sources (say, two different analysts' rankings files) into one board at import time. Because tiers, quiet signals, and roster needs all read straight off the board, a blended import will need no other changes to reach every one of them at once.

## Edit your rankings in-app

Open Settings -> Edit Rankings to reorder the board by hand, without re-importing a file. Drag a row's handle to move a player, or tap a player's rank number to type an exact rank and jump straight there. Tap Done to commit your changes to the board, or Cancel to discard them; Cancel asks for confirmation first if you've moved anyone. Drafted players show their DRAFTED badge in the editor and can still be dragged or rank-jumped like anyone else. Searching inside edit mode is for finding a player: dragging is disabled while a search filter is active, but tapping a player's rank number to jump still works.

Tap a position chip (All/QB/RB/WR/TE/FLEX/DST/K) above the list to scope the editor. FLEX is not a player position -- it's a filter showing the combined pool of RB/WR/TE players, the same three positions that can roll into a FLEX roster slot. Tapping a single position (QB/RB/WR/TE/DST/K) scopes ranks to that position: they display position-scoped, with the overall rank alongside -- e.g. `RB1  #14` -- and the rank-jump card asks for a position rank instead of an overall one ("Move Bijan Robinson to RB rank"). On All or FLEX, each player's rank shows the overall/board rank with their own position rank beneath it (e.g. `14` over `RB3`), and the rank-jump card asks for an overall rank -- FLEX has no ranks of its own. Dragging still works while a position chip is active; only an active text search pauses dragging, a position filter never does.

Manual edits persist until your next Import Rankings.

## Tiers

Tiers group same-position players into named bands (Tier 1, Tier 2, ...). They're scoped per position -- Tier 2 QBs and Tier 2 RBs are unrelated groups, with no relationship to each other. The bundled sample rankings ship with tiers already assigned, banded per position, for all 276 players; importing your own rankings replaces the board (and its tiers) as described next. Import a header-based rankings file (FantasyPros-style CSV/TSV) with a `TIERS` or `TIER` column and tiers come in automatically; the headerless formats (numbered list, plain list, parenthesized team/position) have no column to read a tier from, so those players import untiered. However the source file orders its tier values, the app forces them into non-decreasing order down the board within each position on import, correcting anything out of order in the file itself.

The always-on indicator is a colored T-chip (e.g. `T3`) next to a player's name -- it shows on the main board (Available and Drafted lists) and inside Edit Rankings alike. Divider lines are separate and narrower: they appear only in Edit Rankings, and only while a single position chip (QB/RB/WR/TE/DST/K) is active, marking tier breaks within that position's list. FLEX behaves like All here -- both mix multiple positions, so neither ever shows dividers, only the T-chips. Switching to All or FLEX, or typing a search, clears the dividers; the T-chips keep showing regardless.

Dragging a player across a tier boundary, or rank-jumping him via the rank-jump card, re-tiers only that player so he stays consistent with his new same-position neighbors -- no other player's tier ever changes as a side effect of someone else's move.

Inside Edit Rankings, tap a player's rank to open the rank-jump card; it always includes a Tier -/+ stepper. The stepper is bounded by the nearest same-position tiered players above and below in board order -- untiered rows and other positions in between don't constrain it -- so a tier can never be stepped out of order relative to its same-position neighbors; stepping below the floor clears the tier to none when no same-position player above it is tiered at all.

## Track your own roster

While drafting, mark which picks are yours as you go.

- **Tap DRAFT** to record a pick. Normally that logs someone else's pick; when the tracker says you're up, the buttons turn blue and a tap records the pick as **yours**.
- **Long-press DRAFT** (about half a second -- the button fills while you hold) for the opposite of whatever a tap would do: normally that marks the pick as yours; while you're up it logs someone else's pick.
- Tap the **Mine** chip to filter the board down to your picks. With a league set up (see Draft position tracker, below) it shows a roster board -- one tile per starting slot, filling in as you draft; without one it just lists your picks.
- Made a mistake? In the Drafted or Mine view, tap the person icon on any pick to toggle whether it's yours, no need to undo and redraft.

Without a league set up (see Draft position tracker, below), Mine just lists your picks in draft order, plus a hint tile telling you to set up your league in Settings to see roster slots.

Set a roster template in Settings -> League -- steppers for QB, RB, WR, TE, FLEX, DST, K, and Bench slot counts, alongside the league size/slot/snake settings. The default template (used the first time you set one up) is QB 1, RB 2, WR 2, TE 1, FLEX 1, DST 1, K 1, Bench 7. Once a template is set, Mine becomes a roster board: one tile per starting slot, in order -- QB, RB, WR, TE, FLEX, DST, K, then Bench -- sized to your template (so the default template gives 2 RB tiles, 2 WR tiles, 7 bench tiles, and so on). Tiles fill in as you draft: a filled tile shows the player's name and team with his bye week on the right; an open slot reads "-- empty --". Each of your picks fills its own position's slots first; only an RB, WR, or TE pick can roll into FLEX once its own slot is full -- K and DST have no FLEX eligibility, so once their own slot is full they go straight to Bench. Picks are counted in the order you drafted them, so backfilling marks out of draft order can shuffle which slot a given pick lands in.

## Draft position tracker

Set up your league in Settings -> League: league size, your draft slot, and snake vs. linear draft order (a "Set up draft tracker" button appears there if you haven't configured one yet). Once set, a tracker card appears near the top of the screen, showing the current round, the current overall pick, and how many picks remain until you're on the clock -- or "YOU'RE UP" when it's your pick right now.

The tracker has no separate "record a pick" step: it derives round/pick/picks-until-you entirely from a count of how many players are marked Drafted on the board. Forgetting to mark a pick drifts the tracker out of sync with the real draft, so keep every pick logged as it happens.

Tap "Clear league setup" in Settings -> League to remove your league config. The tracker card disappears, and Mine reverts to plain pick rows (plus the setup hint tile) until you set league config up again.

## Compare players

Long-press a player's row on the main board (Available or Drafted lists -- not the DRAFT/star/x buttons) to add him to a compare tray that appears above the bottom bar; long-press him again to remove him. The tray holds up to 4 players. Tap **Compare** once 2 or more are selected to open side-by-side cards (2 players) or a quadrant layout (3-4); each card shows the player's team/position/bye, tier chip, overall and position rank, and ADP from three sites (ESPN, Yahoo, Sleeper). The ✕ on a card or its tray chip removes that player; Done closes the compare screen and keeps whoever's left selected; Clear empties the tray entirely. Once a league is set up, Mine becomes a roster board (see Track your own roster, above) whose tiles don't long-press into compare -- use the Available/Drafted lists instead.

The bundled sample players carry deterministic FAKE ADP values for ESPN, Yahoo, and Sleeper -- placeholders, not real market consensus. Anyone you import in has no ADP source yet, so those rows read "--" until a future multi-source aggregation round supplies real numbers.

## Quiet signals

Small tags that can appear next to an available player's name. They're passive markers, never suggestions on who to draft; both can show at once, no league setup needed for either:

- **VALUE** -- still on the board 15+ picks past his own rank (and ranked 75 or better).
- **CLIFF** -- the last available player left in his tier at his position.

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
    data.js               seed player data (276 players: QB/RB/WR/TE plus K/DST), team bye weeks, id slugging
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
