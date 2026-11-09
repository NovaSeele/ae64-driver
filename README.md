# AE64 Max Control

**English** · [Tiếng Việt](README.vi.md)

Remake web driver for the Everglide AE64 Max keyboard: tune travel (Actuation, Rapid Trigger, dead zones),
keymap, lighting, macros and more, directly over WebHID.

## Use it online

Open **<https://ae64max.novaseele.com>** in Chrome or Edge, plug in the keyboard and click **Connect keyboard**.
Nothing to install.

- **Google Chrome or Microsoft Edge, desktop version** (WebHID is only available in these browsers).
  Firefox and Safari are not supported.
- An Everglide AE64 Max connected with a USB cable.

## Run it locally (optional)

Only needed if you want to run your own copy instead of the link above. Requires **Node.js 22** (tested with
22.23) on Windows, macOS or Linux.

Double-click **`start.cmd`** in the root folder. The first run installs dependencies and builds; after that it
only starts the preview server at <http://127.0.0.1:4173> and opens the browser. Close the console window to stop it.

### Development

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # type check + build into dist/
npm run preview    # http://127.0.0.1:4173
npm test           # vitest
npm run typecheck
```

## Usage

1. Click **Connect keyboard** and pick `AE64-MAX` in the browser dialog. Next time the app reconnects to the
   keyboard you already granted access to.
2. No keyboard? Click **Demo mode** to try it with a simulated keyboard.
3. Select keys on the keyboard picture (Ctrl/Shift to add more, drag to box-select, Esc to clear), then adjust
   them in the tabs below. Changes are **written to the keyboard automatically** after ~0.35 s; the status shows
   at the top ("Saved to keyboard" / "Writing…" / "Error — retry").
4. **Ctrl+Z / Ctrl+Y** to undo / redo within the session.

## App updates

Unlike the manufacturer's driver, which downloads new versions in the background, AE64 Max Control **never
updates itself**. The app keeps running the version it has until the user checks for and applies an update.

- The service worker (`sw.js`) is a static file that does not change between builds, so the browser never picks
  up a new version on its own.
- The build produces `release.json` (version, build time and the release's file list).
- When the user opens the Help dialog and clicks **Check for updates**, the app compares its version with
  `release.json`.
- On **Update**, the service worker downloads every file of the new release into a new cache (all-or-nothing),
  switches versions and reloads the page.
- The web server (nginx) serves `/assets/` as immutable, and `index.html`, `sw.js` and `release.json` as
  `no-cache` / `no-store`.

## Safety

- The app **never** sends firmware update commands (family `08`) or a factory reset; the "Factory reset" keycode
  is not in the key picker either.
- It writes only when the board is `0030000D` (AE64 Max) or `0030000A` (AE64 Pro); other keyboards open
  read-only.
- Every travel write keeps the switch/calibrate values read from the keyboard, then reads back to compare.
- The last line of defence lives in the transport (`src/protocol/safety.ts`): every packet must be in the list of
  allowed commands and pass argument range checks (profile, layer, row/column, save group…). A packet that does
  not match is blocked before it reaches the keyboard, whichever page built it.
- A travel write is refused if that key was not read first, if it changes the sensor fields (`axis`,
  `calibrate`), if it changes the switch fields (`axisV2Id`, `axisRangeMax`, `axisCoefficient`) to anything but
  a value the key reported or a whole entry from the board's switch list, or if a distance exceeds the switch's
  travel.
- Travel modes: `0` Standard, `1` Continuous Rapid Trigger, `2` Interval Rapid Trigger (IntervalRT in the
  original driver). The app reads the raw value from the key and keeps it on write; mode `2` is written only
  when the keyboard reports protocol ≥ 1.3.0.0 (the original driver's condition) or the key is already in mode `2`.
- Dangerous keycodes (Factory reset F200, wireless mode switches, clear pairing) are never written, including
  from a backup file or when restoring a default layer.
- Global settings (OS, lights off, debounce) are written directly like the original driver, without a commit.
  A polling rate change is always the last command of a session (the keyboard restarts its USB port), after
  which the app reconnects; the polling rate is not restored from backup files.
- If a calibration is interrupted, the app still sends the stop-calibration command (without saving).
- If the original driver (hub.xsyd.top) is open in another tab, close it before connecting.

## Docs

- `docs/ARCHITECTURE.md` — folder layout, the per-key page model, how to add a new page.
