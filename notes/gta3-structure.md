# GTA III (WASM Arcade, re3 WebAssembly) — structure map

Source: https://wasmarcade.com/gta3 · captured with ZERO on 2026-11-21 · authorized by WASMARCADE (written permission, forking and editing for debugging/security work).
Capture lives in `ZEROED/GTA 3 Online - Play GTA III in Your Browser WASM Arcade (5)/` (git-ignored; contains Rockstar data, keep local, do not redistribute).

## 1. Stack in one line
React/Vite site shell (`assets/*.js`) → classic-script loader `games/gta3/game.js` → Emscripten glue `games/gta3/index.js` → `re3.wasm` (3.4 MB, re3 compiled to WASM, OpenAL + GLFW + WebGL2 on one `<canvas id="canvas">`). Single origin (wasmarcade.com), Cloudflare in front, no WebSockets, no game server, no netcode. Everything is static files.

## 2. Boot sequence (what happens after Play)
1. Page load: React shell + `game.js` (versioned `?v=163j1ub`) + `gamepad-emulator.js`. Engine is NOT loaded yet.
2. User clicks `#gta3-launch-btn` → `window.startGame()` (`bootGame`). Play also opens a sponsor tab (ad network; ZERO blocks it, `hai8g.com`).
3. `setStatus('Loading engine…')` → load `/gta3sky/packages.js` (defines `window.DATA_PACKAGE`) → load `/games/gta3/index.js` (Emscripten glue, `createRe3Module`).
4. `createRe3Module(Module)`: `instantiateWasm` fetches `/games/gta3/re3.wasm?v=…` via CacheStorage (`gta3-chunks-116440535`).
5. `loadDataChunks()`: downloads 6 chunks `/gta3sky/gta3-data.data.00..05` in parallel, slices them into an in-RAM cache by the file table in `DATA_PACKAGE.files` (1316 files).
6. `loadPreloadList()`: `/games/gta3/preload_files.list` (1316 paths) decides what is written into the Emscripten VFS at `/gta3-assets/local/…` before `main`.
7. `warm.json` (`warmStartupAssets`): low-priority prefetch of hot SFX/audio into OPFS.
8. `Module.mainCalled()` → engine runs. Log lines printed by the engine drive the JS side (`updateStatusFromRegta3`): `gGameState = GS_FRONTEND` / `GS_PLAYING_GAME` marks the game started, then prefetches `anim/cuts.img`, `audio/bet.mp3`, `audio/head.wav`, `audio/sfx.sdt`; `post-intro stream` prefetches first-mission audio; `per-sample MP3 bank` prefetches hot SFX; `full path was models/X.txd` triggers a lazy fetch of that texture.
9. Saves/settings: IDBFS at `/gta3-assets/local/userfiles` (IndexedDB), `re3.ini` in localStorage (`regta3dos.re3.ini`), assets cached in OPFS/CacheStorage. `gta3.set`, `gta3.ini`, `playback.dat`, `record.dat` are never fetched from the server (`NEVER_ON_SERVER`).

In the headless run everything above completed within ~20 s; `head.wav` was requested at ~12.5 s, which only happens after the engine printed `GS_PLAYING_GAME`.

## 3. Files on the wire (741 files, ~162 MB captured)
| Path | Size | Role |
|---|---:|---|
| `gta3sky/gta3-data.data.00–04` | 5 × 20.0 MiB | file_packager data package, fixed 20 MiB chunks |
| `gta3sky/gta3-data.data.05` | 11.6 MB | final chunk (total 116,440,535 B = `remote_package_size`) |
| `gta3sky/packages.js` | 136 KB | `DATA_PACKAGE`: chunk list + `{filename,start,end}` table |
| `games/gta3/re3.wasm` | 3.4 MB | engine |
| `games/gta3/index.js` | 521 KB | Emscripten glue + regta3 JS library |
| `games/gta3/game.js` | 80 KB | loader, caching, audio, input, status/hang watchdog |
| `games/gta3/gamepad-emulator.js`, `games/loader-ui.js` | 26 KB, small | input emulation, loading UI |
| `games/gta3/preload_files.list`, `warm.json` | 64 KB, 35 KB | boot preload set, audio warm-up set |
| `gta3-assets/local/models/**` | ~27 MB, 583 files | extra per-file streamed models/TXD (`models/gta3.img/*.dff|txd`, fonts, buttons) |
| `gta3-assets/local/audio/**` | ~13 MB | `head.wav`, `sfx.sdt`, `sfx.raw/NNN.mp3` (per-sample MP3 bank), `lib_*.wav`, cutscene/mission mp3 stems |
| `gta3-assets/local/text/**` | 0.4 MB | GXT language files |

Note the package covers everything needed to boot; per-file fetches under `gta3-assets/local/` are the lazy/streamed layer on top (`fetchAsset`, `prefetchAssetAsync`, `loadAsyncFile`).

## 4. Data package contents (116.4 MB, 1316 files)
- `anim/` 45.7 MB: `cuts.img` (42.6 MB), `ped.ifp`, `cuts.dir`
- `models/gta3.img/` 30.3 MB, 1154 files (the `.dff`/`.txd` world, unpacked IMG)
- `models/` 17.1 MB (menu.txd 7.7 MB, frontend.txd 4.8 MB, fonts, `generic/`, `coll/*.col`)
- `txd/` 9.6 MB (32 files), `data/maps/` 5.9 MB (60 files: `.ipl`/`.ide`), `data/` 1.5 MB (`gta3.dat`, `main.scm`, handling.cfg, timecyc, ped/weapon/object .dat), `text/` 0.6 MB, `audio/` (`bet.mp3`, `sfx.sdt`), `gta3.set|ini`, `playback.dat`, `record.dat`
- Types: 1042 `.dff`, 163 `.txd`, 28 `.ipl`, 25 `.dat`, 22 `.col`, 18 `.ide`, 3 `.gxt`, `.scm`, `.ifp`, `.img`, `.sdt`
- 4 files straddle a chunk boundary, so the chunks must be concatenated in order to reslice.

## 5. Browser features the game depends on
WebAssembly, WebGL 2 (preserveDrawingBuffer off, antialias on), OPFS (worker), CacheStorage, IndexedDB (IDBFS), pointer lock, Web Audio/OpenAL, Gamepad API. `Cross-Origin-Isolation` is not required by the capture (ran fine without `--isolate`).

## 6. Server behaviour to know
- The `/gta3sky/*.data.NN` chunks return **403 to a plain `curl`** and 200 to the page's own requests. Do not forge headers; capture through the browser session (ZERO now does).
- Missing files return an empty 200 instead of 404 (`audio/sound.cache` is a 0-byte 200, same hash as an empty JS). Treat any 0-byte "success" as a miss.
- Asset URLs carry `?v=163j1ub`; ZERO stores them as `file~227a5c.ext`.

## 7. ZERO fixes made for this game
- `src/capture.ts`: large binary packages (`.data|.pak|.pck|.bin|.zip|.img` with optional `.NN`) are now read through `route.fetch()` and saved, because Chromium evicted 20 MB parallel responses from its inspector cache ("Request content was evicted"). Failures are now logged in `skipped` instead of swallowed.
- `src/capture.ts`: `res.body()` retried and its reason recorded.
- `src/crawl.ts`: raises CDP network buffer limits (harmless; did not fix the eviction by itself).
- `flows/gta3-boot.json`: clicks `#gta3-launch-btn`, waits for boot, presses Enter through the menu.

## 8. Known gaps / next steps
- Not captured: gameplay-driven streaming past the first ~20 s (more `sfx.raw/*.mp3`, `audio/*.mp3` mission stems, radio streams). Needs a longer scripted flow that actually drives the game.
- Replay check not yet done: `zero serve --isolate --port N "<fork dir>"` then confirm `GS_PLAYING_GAME` appears in the console.
- Analogs of the PlayFive bugs to check in `game.js`/glue once edits start: unchecked `JSON.parse` of fetched files (`warm.json`, `preload_files.list` have fallbacks), and loading gates that wait on assets that never arrive.
