# Architecture

AE64 Max Control is a Vite + Vue 3 + TypeScript + Pinia app that talks to the keyboard over WebHID.
Everything runs locally; there are no network calls besides the app's own origin.

## Folder map

```
src/
  protocol/            Device protocol — contract: specs contracts/protocol.ts (types.ts is a verbatim copy)
    constants.ts       report size, filters, ALLOWED_BOARDS, families, SAVE_GROUP, LED/macro sizes
    codec.ts           pure encoders/decoders (µm ↔ mm, LE16, BE board id, BGR+flag, advanced, macro paging)
    client.ts          BaseTransport: the whole Ae64Transport API over one `exchange(frame)` primitive.
                       Serialised queue (one request in flight), stats, packet log, write guard
                       (writes refused until 01 02 reports an allowed board), family 08 refused.
    hid.ts             HidTransport (WebHID, 1.5 s timeout, reply matched on bytes 0–1, disconnect event),
                       connectHid(), reconnectGrantedHid()
    mock.ts            MockTransport: byte-level AE64 Max emulator seeded from device-snapshot.md
                       (4 profiles, writes persist, simulatePress(keyId, mm) for axis data, ~2 ms latency)
    layout.ts          PHYSICAL_KEYS (64 keys, sparse SENSOR_COLUMNS), 03 05 discovery merge
    keycodes.ts        KEYCODE_GROUPS (picker), keycodeLabel(), modifier combos (mask in high byte)
  stores/              Pinia stores — contract: specs contracts/stores.md
    device.ts          connection, info, profiles, keys, layer-0 legends, withTransport(), onProfileChanged()
    selection.ts       selected key ids, focus, select/selectMany/all/invert/wasd/clear
    sync.ts            write queue: coalesce by key → debounce 350 ms → write → commit per group → verify
    history.ts         undo/redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z), gesture coalescing
    performance.ts     per-key page store for Hành trình (the reference pattern below)
  components/
    ui/                Button, IconButton, Slider, NumberField, Switch, Segmented, Card, Tooltip, Dialog,
                       Toast (+ toast.ts useToast), Tabs, ColorPicker, KeyPicker, AnimatedNumber
    keyboard/          KeyboardView, Keycap, SelectionBar
    shell/             Rail, Sidebar, DeviceCard, ProfileSelect, TopBar, ConnectScreen, PageLayout, EmptyState
    performance/       TravelEditor (switch illustration + vertical travel slider)
  pages/               one file per route (XxxPage.vue); lazy-loaded by router.ts
  i18n/vi.ts           every UI string; use t('key', { params })
  styles/              tokens.css (design tokens), base.css (resets, utilities, page transition)
tests/                 vitest: codec vectors, stores (sync/history/selection/performance), UI kit
```

## Rules every page follows

- Talk to the keyboard only through `useDeviceStore().withTransport(t => …)`. Pass `{ exclusive: true }`
  for multi-request jobs that must not interleave with pollers (the sync store already does).
- Never write directly from a component. Edits go through the page store → `history.push` → `sync.enqueue`.
- Distances are millimetres everywhere above the codec.
- All strings come from `src/i18n/vi.ts` via `t()`; Vietnamese with English technical terms.
- Use the UI kit and tokens; no new colours outside `tokens.css`.

## The per-key page pattern (see `stores/performance.ts` + `pages/PerformancePage.vue`)

1. **Load.** The page calls `store.load()` on mount and `store.load(true)` from `device.onProfileChanged`.
   `load()` reads every key sequentially inside one `withTransport` call, keeps a progress counter for the
   skeleton UI, and stores two copies: `values` (what the UI shows and edits) and `fresh` (the last record
   read from the board). Data is cached per profile.
2. **Display.** The page renders `<PageLayout keyboard>` with its own `<KeyboardView>` in the `keyboard`
   slot, passing `legend` (`device.legend`, live layer-0 keymap), `sublabel` (the chosen metric) and
   optionally `fill`/`color`/`state`. Metric chips and actions go into `keyboard-aside`.
   Editors summarise the current selection (`useSelectionStore().ids`): a single value when all keys agree,
   otherwise `null` (mixed) plus a `[min, max]` range for the slider band.
3. **Edit.** Every control calls `store.apply(ids, patch, label, coalesce?)`:
   - computes before/after per key (clamped and rounded), skips no-ops,
   - updates `values` immediately (the UI never waits for the device),
   - enqueues one sync job per key (`key: '<page>:<profile>:<keyId>'`, so rapid edits coalesce, last wins),
   - pushes one history entry whose `undo`/`redo` re-run the same commit path. Continuous gestures
     (slider drags) pass a `coalesce` id so a whole drag becomes one undo step.
4. **Write & verify.** The sync job's `write` merges the edited fields over the `fresh` record, so firmware-
   owned fields (axis, calibrate, axisV2Id, axisRangeMax, axisCoefficient) are always preserved. The sync
   store commits once per save group, then runs each job's `verify`, which reads the record back, refreshes
   `fresh` and compares the edited fields. A mismatch puts the top-bar pill into "Lỗi — thử lại".
5. **Profile safety.** `device.switchProfile()` flushes the sync queue first and clears history; `commit`
   ignores history entries from another profile.

## Adding a page (phase 2)

1. Replace the placeholder `src/pages/XxxPage.vue` (the route already exists in `router.ts`).
2. If the page edits device state, add `src/stores/xxx.ts` following `performance.ts`: `load()`, `apply()`,
   sync jobs with the right `SAVE_GROUP`, `verify` by read-back, history entries.
3. Wrap the page in `<PageLayout :title="t('page.xxx')" :keyboard="perKey">`; put page controls in cards
   (`Card`) in the default slot.
4. Add strings to `src/i18n/vi.ts`.
5. Add codec/store tests in `tests/` for any new byte handling; the mock transport (`MockTransport`) answers
   every family-01…07 packet and keeps writes, so stores can be tested end-to-end.
6. Pollers (live travel, LED preview) must stop on unmount and pause while `device.exclusiveActive` is true.

## Updates & offline caching

Updates run strictly on demand when requested by the user:

- `public/sw.js` is byte-static across builds. Browsers check service worker scripts byte-by-byte and find no differences, preventing silent auto-reloads.
- Builds emit `dist/release.json` via `build/release.ts`: `{ version, builtAt, files }`, where `version` matches `__APP_VERSION__` (`package.json` version + UTC timestamp).
- The page registers `sw.js` only after `load`, when idle, so the first visit's precache does not compete with the page's own chunks and font.
- On initial install, `sw.js` fetches `release.json` (no-store), populates cache `ae64-app-<version>`, and records the version in `ae64-meta`. Unhashed files (`/`, `index.html`, manifest, `theme-boot.js`) are fetched `no-cache`; hashed `/assets/` files may come from the HTTP cache (install and apply alike).
- Fetch interceptor: navigations return cached `index.html`; app assets return cache-first; `release.json` always fetches network `no-store`.
- Update flow: the user clicks "Check for updates" in Rail help; page posts `{ type: 'check' }` to SW via MessageChannel. If a new version exists, the user can click "Update", triggering `{ type: 'apply' }`, which atomically caches all new files, swaps `ae64-meta`, deletes the old cache, and triggers `location.reload()`.
- An `apply` without a `version` (pages built before da1f195) takes the latest release, still only when it is newer.
- The favicon lives in `src/assets/` so Vite hashes it (`/assets/favicon-[hash].svg`), which means a changed icon is never held by a CDN or browser cache. `index.html` links it through Vite, and the `ae64-manifest-icon` plugin in `vite.config.ts` points the copied `manifest.webmanifest` at the hashed file. If no hashed favicon is found, the build fails.
- Production hosting (nginx, `/etc/nginx/sites-available/ae64max` on the VPS, not in this repo): `/assets/` immutable; every other path (`index.html`, `sw.js`, `release.json`, the manifest, and unhashed root files such as `theme-boot.js`) is sent `Cache-Control: no-cache`, so Cloudflare revalidates them with the origin (`cf-cache-status: REVALIDATED`) and an `apply` never pins a stale copy into the new version's cache. Each `location` that uses `add_header` repeats the server-level security headers, because nginx drops them otherwise. The Cloudflare zone's Browser Cache TTL still rewrites the browser-facing header of cacheable extensions (`.js`, `.svg`) to `max-age=14400`; setting it to "Respect existing headers" removes that.
- Content-Security-Policy (set twice in that file: server block and the `index.html` location):
  `default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`.
  `https://static.cloudflareinsights.com` is there on purpose: Cloudflare Web Analytics auto-injects its beacon (visitor statistics), served from `/beacon.min.js/v<hash>`, so the source is the whole host, not a path. The beacon reports to `/cdn-cgi/rum` on this origin, so `connect-src` stays `'self'`. Do not remove it, and do not widen the policy beyond it (no inline scripts, no `unsafe-*` for scripts).
