# ZERO

A second-person view of your own game. ZERO loads a game you own in a disposable headless Chromium, plays it for a while,
and forks everything into `ZEROED/<tab title>/`: pages, every asset, every server call and WebSocket frame, runtime info,
plus a report of what to improve.

## Setup (once)

```bash
cd ~/Projects/ZERO
npm install && npx playwright install chromium
alias zero="npx tsx ~/Projects/ZERO/src/cli.ts"     # optional, the examples below use `zero`
```

## The safety rail: the allowlist

ZERO only forks origins you explicitly authorize, and only over `https://` / `wss://`.

```bash
zero allow https://mygame.example      # authorize (exact origin: scheme + host + port)
zero allowed                            # show the list (stored in zero.config.json)
```

During a run, any request to an origin that is not allowlisted is blocked, not sent, and logged. That is also how you
discover what a game talks to (see "Blocked" in the report).

## fork: capture a game

```bash
zero fork https://mygame.example --game            # preset: depth 0, 45s play session with input
zero fork https://mygame.example --play 120        # longer session (more lazy assets, more socket traffic)
zero fork https://mygame.example --play 60 --no-input   # observe only, never click/press keys
zero fork https://mygame.example --depth 2 --max-pages 50   # crawl a multi-page site instead
zero fork https://mygame.example --no-clean         # keep analytics/trackers
zero fork https://mygame.example --out ~/Desktop/forks
```

| Flag | Meaning |
|---|---|
| `--game` | Single page, 45 s play session with input. Right for most web games. |
| `--play <sec>` | Stay on the landing page this long. Games load assets and open sockets late; this catches them. |
| `--no-input` | During play, do not click/press keys. Use when input would change server state. |
| `--script <flow.json>` | Run a scripted flow (clicks, keys, waits) during play instead of the generic poke. Implies depth 0 and a 60 s session. Cannot be combined with `--no-input`. |
| `--depth`, `--max-pages` | Same-origin crawl limits for multi-page sites. |
| `--no-clean` | Do not strip analytics/tracker scripts. |
| `--out` | Output root (default `ZERO/ZEROED`). |

During play, ZERO clicks the screen centre, presses Space and Enter (three times, spread across the session) to get past
"click to start" gates. It cannot play your game, so anything behind real gameplay needs a longer or scripted session.

## Scripted flows (`--script`)

The generic poke only clears "click to start" screens. To get into real gameplay, write a flow: a JSON array of steps run
inside the play session. The session length (`--play`, default 60 s with a script) is a hard limit: the flow stops there, then
ZERO keeps observing until the time is up. A failed step aborts the flow (mark it `"optional": true` to skip instead), and
the run still finishes and writes its report. Unknown keys are rejected, so typos fail loudly.

```json
[
  { "wait": 1500 },
  { "click": "button:visible:text-is('CLOSE')", "optional": true },
  { "click": "#startBtn" },
  { "waitFor": "canvas", "timeout": 8000 },
  { "repeat": 10, "steps": [
      { "press": "KeyW", "hold": 700 },
      { "mouse": { "move": [900, 300] } },
      { "click": [720, 450] }
  ] }
]
```

| Key | Does |
|---|---|
| `wait` | Pause, in ms (max 30000). |
| `waitFor` | Wait for a CSS selector to appear. |
| `click` | CSS selector, or `[x, y]` viewport coordinates (viewport is 1440×900). |
| `clickText` | Click the first element containing this text. |
| `press` (+ `hold`) | Press a key, optionally holding it N ms. Names: `Space`, `Enter`, `KeyW`, `ArrowUp`... |
| `type` (+ `into`) | Type text, into a selector if given. |
| `mouse` | `{ "move": [x, y], "down": true, "up": true }`. |
| `scroll` | Mouse wheel delta Y. |
| `timeout` | Per-step selector wait in ms (default 5000). |
| `optional` | Skip instead of aborting if this step fails. |
| `repeat` + `steps` | Run the nested steps N times (max 1000). |

Tips: pop-ups (news, updates, cookie notices) often cover the menu on a first visit and block clicks, so dismiss them first.
A flow acts as a real player on your live server, so aim it only at flows you are happy to have run against production.
Example: `flows/fortlite-quickmatch.json`.

## What you get in `ZEROED/<Title>/`

| Path | Contents |
|---|---|
| mirrored files (`index.html`, `assets/...`) | The fork itself, paths mirror the site, links rewritten to relative. Cross-origin assets (if you set `assetOrigins`) go under `_ext/<host>/`. URLs with query strings get a `~hash` suffix before the extension. |
| `zero.manifest.json` | Every page and asset: URL, local file, sha256, bytes, **kind** (image, texture, audio, video, model, wasm, shader, font, script, style, data), content-type, content-encoding, cache-control. Also the blocked/skipped list and removed trackers. |
| `zero.network.jsonl` | One JSON event per line, timestamped (ms): `http` (fetch/XHR with method, status, size, POST body preview), `ws-open`, `ws-sent`, `ws-recv` (frame size, text or base64 preview of first 512 bytes), `ws-close`, `blocked`, plus WebRTC: `rtc-open` (ICE servers used vs requested), `rtc-channel` (label + ordered/reliability options), `rtc-sent`/`rtc-recv` (data-channel messages), `rtc-state` (connection/ICE states), `rtc-ice` (candidate type/protocol only), `rtc-media` (getUserMedia use). This is your netcode log. |
| `zero.services.json` | Detected backend/hosting services (Firebase, Netlify, Supabase, Vercel, Cloudflare, PlayFab, Photon, AWS, GitHub Pages, itch.io): roles, project IDs, evidence, whether seen live or only referenced in code, whether the allowlist blocked its traffic, and the origins to allow. |
| `zero.runtime.json` | Detected engine(s) (Unity, Godot, Phaser, Pixi, Three, Babylon, PlayCanvas, Cocos, Construct, Kaboom, ...), netcode libs (Socket.IO, Colyseus, Photon, PeerJS, ...), canvas sizes, WebGL version and GPU, save-data key *names* (never values), IndexedDB names, JS heap. |
| `zero.report.md` | The readable summary plus the **Second-person improvements** list. |

Folder name = sanitized tab title; a second fork of the same title becomes `Title (2)`.

## report, list, serve

```bash
zero list                                  # all forks with source, time, page/asset counts
zero report "Neon Drift (alpha)"           # print the report again
zero serve  "Neon Drift (alpha)" --port 8080          # play the fork at http://127.0.0.1:8080
zero serve  "Neon Drift (alpha)" --isolate            # adds COOP/COEP (threaded wasm / SharedArrayBuffer builds)
```

Use `serve` rather than opening files: games use root-relative paths (`/assets/x.png`) that only work from a server.
It binds to 127.0.0.1 only, supports HTTP Range (audio/video seeking) and resolves `?query` URLs to their captured files.
The fork's sockets still point at your real server (they are not mocked), so it connects to the live game server when
that origin is reachable.

## WebRTC

ZERO injects a small hook (`src/rtc-inject.js`) before your game's code runs. It wraps `RTCPeerConnection`, data channels
and `getUserMedia`, and records:

- which ICE servers (STUN/TURN) the game requested and which were used,
- connection and ICE state changes (`checking → connected`, or `failed`),
- candidate **types** only (`host`/`srflx`/`relay` and `udp`/`tcp`). Candidate IP addresses are never recorded,
- every data channel, with its options, and every message in both directions (size, text/binary, first 512 bytes),
- whether the game asked for microphone/camera.

TURN usernames and credentials are never recorded. **STUN/TURN hosts are filtered to your allowlist** like everything else:
a non-allowlisted ICE server is removed from the connection config and logged as blocked. To keep your own server, run
`zero allow https://turn.mygame.example --asset` (it matches on the hostname).

What ZERO cannot do: block or inspect the direct peer-to-peer UDP traffic itself. A single ZERO session also has no other
players, so a fork run shows setup, signalling-side behaviour and your own data-channel traffic, not a full match.

## Firebase, Netlify and other services

Detection uses four kinds of evidence, so it works even when a call is blocked or never happens during play:

1. **Traffic and blocked attempts** (hosts and paths such as `*.firebaseio.com`, `firestore.googleapis.com`, `/.netlify/functions/...`),
2. **Response-header fingerprints** (`server: Netlify`, `x-nf-request-id`, `x-vercel-id`, `cf-ray`, ...),
3. **Code references**: URLs and `projectId` found inside the captured scripts and HTML (marked "referenced in code only"),
4. **SDK globals** in the page (`firebase`, `netlifyIdentity`, `supabase`, `PlayFab`).

For Firebase the report names the roles (Realtime Database, Firestore, Auth, Storage, Functions, Hosting, Messaging) and project
IDs. API keys are never printed. For Netlify it lists hosting, Functions, Identity and Large Media. If a service's traffic was
blocked, the report gives the exact `zero allow <origin> --asset` command to capture it on the next fork.

To add a service, append a rule to `URL_RULES` or `HEADER_RULES` in `src/services.ts`.

## Reading the improvements list

| Finding | Do this |
|---|---|
| Asset over 1 MB | Split, stream, or lazy-load after first playable frame. |
| Text/wasm over 50 KB with no gzip/brotli | Turn on compression on the server/CDN. |
| No long-lived `Cache-Control` | Add `max-age` (and content-hashed filenames), returning players stop re-downloading. |
| Duplicate files (same sha256) | Deduplicate / reference one copy. |
| WAV/AIFF over 200 KB | Re-encode OGG/Opus or MP3 (typically 5-10x smaller). |
| PNG/BMP over 500 KB | WebP/AVIF; KTX2/Basis for GPU textures (also saves VRAM). |
| .obj/.fbx/.dae | glTF/GLB with Draco or meshopt. |
| Socket receives more than 30 frames/s | Batch/delta state, lower tick for non-critical data. |
| Large text socket frames | Binary format (MessagePack, protobuf, flatbuffers). |
| Socket closes with an odd code | Check for unexpected disconnects/timeouts. |
| Origins outside the allowlist | Your own? `zero allow <origin> --asset` and re-fork. Not yours? Note the third-party dependency. |
| WebRTC: STUN only, no TURN | Add a TURN server. Players behind symmetric NAT/strict firewalls cannot connect otherwise. |
| WebRTC: data channel message over 16 KB | Chunk it (browser interop limit). |
| WebRTC: reliable+ordered channel with heavy traffic | For position/state updates use `ordered: false, maxRetransmits: 0`. |
| WebRTC: failed state | Check ICE server reachability. |
| Firebase detected | Review Security Rules (the client config is public by design); test with the Emulator Suite. |
| Netlify Functions called | Check cold starts, payload size, and server-side validation (every function is publicly callable). |

## Config (`zero.config.json`)

| Key | Default | Meaning |
|---|---|---|
| `allow` | `[]` | Authorized origins (manage with `zero allow`). |
| `assetOrigins` | `[]` | Extra origins allowed for assets/sockets (e.g. your CDN, `https://cdn.mygame.example`). Edit by hand. Captured under `_ext/`. |
| `clean` | `true` | Strip analytics/trackers. |
| `depth`, `maxPages` | 3, 200 | Crawl limits when not using `--game`. |
| `maxBytes` | 500 MB | Total asset cap per fork. |
| `pageTimeoutMs` | 30000 | Per-page load timeout. |

## Limits worth knowing

- Only `https://` and `wss://`. Plain `ws://`/`http://` are refused.
- Login-gated or account-bound games are out of scope for now.
- Raw peer-to-peer UDP and non-browser transports (WebTransport, native sockets) are not captured. WebSocket, fetch/XHR and WebRTC signalling/data channels are.
- A fork captures what the play session touched; content behind later levels needs a longer `--play`.
- Self-signed certs are rejected by default. For a local https dev server only, `ZERO_TEST_IGNORE_TLS=1` disables that check.
- `ZERO_TEST_RTC_LOOPBACK=1` (test-only, off by default) lets two peer connections in one page connect over loopback.

## Config file

`zero.config.json` is your local allowlist and is not committed. It is created from `zero.config.example.json` the first time you run any command.
