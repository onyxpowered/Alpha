import type { NetEvent } from './capture.js';
import type { RuntimeProbe } from './probe.js';
import type { DetectedService } from './services.js';
import type { Manifest } from './store.js';

const mb = (n: number) => (n / 1048576).toFixed(2) + ' MB';
const kb = (n: number) => (n / 1024).toFixed(1) + ' KB';
const TEXTY = new Set(['script', 'style', 'data', 'shader', 'wasm']);
const CACHEABLE = new Set(['image', 'texture', 'audio', 'video', 'model', 'wasm', 'font', 'script', 'style']);

interface WsStat { url: string; sent: number; recv: number; sentBytes: number; recvBytes: number; binary: number; text: number; spanMs: number; samples: string[]; closed?: number }

function wsStats(events: NetEvent[]): WsStat[] {
  const m = new Map<string, WsStat & { first: number; last: number }>();
  for (const e of events) {
    if (!e.kind.startsWith('ws-')) continue;
    const s = m.get(e.url) ?? { url: e.url, sent: 0, recv: 0, sentBytes: 0, recvBytes: 0, binary: 0, text: 0, spanMs: 0, samples: [], first: e.t, last: e.t };
    s.last = e.t;
    if (e.kind === 'ws-sent') { s.sent++; s.sentBytes += e.size ?? 0; }
    if (e.kind === 'ws-recv') { s.recv++; s.recvBytes += e.size ?? 0; }
    if (e.kind === 'ws-sent' || e.kind === 'ws-recv') {
      e.binary ? s.binary++ : s.text++;
      if (s.samples.length < 4 && !e.binary && e.payload) s.samples.push(`${e.kind === 'ws-sent' ? '→' : '←'} ${e.payload.slice(0, 140)}`);
    }
    if (e.kind === 'ws-close') s.closed = e.status;
    m.set(e.url, s);
  }
  return [...m.values()].map((s) => ({ ...s, spanMs: s.last - s.first }));
}

interface RtcPc { id: string; servers: string[]; requested: string[]; states: string[]; ice: Record<string, number>; channels: { label: string; opts: string; sent: number; recv: number; sentBytes: number; recvBytes: number; maxMsg: number; closed: boolean }[] }

function rtcSummary(events: NetEvent[]): { pcs: RtcPc[]; media: string[] } {
  const pcs = new Map<string, RtcPc>();
  const media: string[] = [];
  const pc = (id: string): RtcPc => {
    let p = pcs.get(id);
    if (!p) pcs.set(id, (p = { id, servers: [], requested: [], states: [], ice: {}, channels: [] }));
    return p;
  };
  for (const e of events) {
    if (!e.kind.startsWith('rtc-')) continue;
    if (e.kind === 'rtc-media') { media.push(e.payload ?? ''); continue; }
    const [id, label] = e.url.replace('rtc:', '').split('/');
    const p = pc(id!);
    const ch = label !== undefined ? (p.channels.find((c) => c.label === label) ?? (p.channels.push({ label, opts: '', sent: 0, recv: 0, sentBytes: 0, recvBytes: 0, maxMsg: 0, closed: false }), p.channels.at(-1)!)) : null;
    if (e.kind === 'rtc-open') {
      try {
        const j = JSON.parse(e.payload ?? '{}') as { iceServers?: string[]; requested?: string[] };
        p.servers = j.iceServers ?? [];
        p.requested = j.requested ?? [];
      } catch { /* ignore */ }
    } else if (e.kind === 'rtc-state') {
      if (ch) { if (e.payload?.startsWith('channel-')) ch.closed = true; } else if (e.payload && p.states.at(-1) !== e.payload) p.states.push(e.payload);
    } else if (e.kind === 'rtc-ice') p.ice[e.payload ?? '?'] = (p.ice[e.payload ?? '?'] ?? 0) + 1;
    else if (ch && e.kind === 'rtc-channel') ch.opts = e.payload ?? '';
    else if (ch && e.kind === 'rtc-sent') { ch.sent++; ch.sentBytes += e.size ?? 0; ch.maxMsg = Math.max(ch.maxMsg, e.size ?? 0); }
    else if (ch && e.kind === 'rtc-recv') { ch.recv++; ch.recvBytes += e.size ?? 0; ch.maxMsg = Math.max(ch.maxMsg, e.size ?? 0); }
  }
  return { pcs: [...pcs.values()], media };
}

export function buildReport(man: Manifest, events: NetEvent[], rt: RuntimeProbe | null, services: DetectedService[] = []): string {
  const L: string[] = [];
  const findings: string[] = [];
  const totalBytes = man.assets.reduce((a, x) => a + x.bytes, 0);

  L.push(`# ZERO report: ${man.title}`, '', `Source: ${man.source}  ·  Forked: ${man.forkedAt}`, '');

  // ---- runtime
  if (rt) {
    L.push('## Runtime');
    L.push(`- Engines detected: ${rt.engines.join(', ') || 'none recognised'}`);
    if (rt.netLibs.length) L.push(`- Netcode libraries: ${rt.netLibs.join(', ')}`);
    if (rt.serviceGlobals?.length) L.push(`- Service SDKs in page: ${rt.serviceGlobals.join(', ')}`);
    L.push(`- Canvases: ${rt.canvases.map((c) => `${c.width}×${c.height}`).join(', ') || 'none'}`);
    if (rt.webgl) L.push(`- WebGL: ${rt.webgl.version} (${rt.webgl.renderer})`);
    L.push(`- Save data: localStorage keys [${rt.localStorageKeys.join(', ')}], IndexedDB [${rt.indexedDB.join(', ')}]`);
    if (rt.jsHeapMB !== null) L.push(`- JS heap after play: ${rt.jsHeapMB} MB`);
    L.push('');
  }

  // ---- assets
  L.push('## Assets', '', `Total captured: ${man.assets.length} files, ${mb(totalBytes)}`, '', '| Kind | Files | Size |', '|---|---:|---:|');
  for (const [k, v] of Object.entries(man.summary ?? {}).sort((a, b) => b[1].bytes - a[1].bytes)) L.push(`| ${k} | ${v.count} | ${mb(v.bytes)} |`);
  L.push('', '### Heaviest 10', '');
  for (const a of [...man.assets].sort((x, y) => y.bytes - x.bytes).slice(0, 10)) L.push(`- ${kb(a.bytes)}  \`${a.file}\` (${a.kind})`);
  L.push('');

  // ---- servers
  const origins = new Map<string, { http: number; ws: number; bytes: number }>();
  for (const e of events) {
    if (e.kind === 'blocked' || e.kind === 'ws-close' || e.kind.startsWith('rtc-')) continue;
    const o = new URL(e.url).host;
    const s = origins.get(o) ?? { http: 0, ws: 0, bytes: 0 };
    if (e.kind === 'http') s.http++;
    else if (e.kind === 'ws-open') s.ws++;
    s.bytes += e.size ?? 0;
    origins.set(o, s);
  }
  L.push('## Server connections', '');
  if (origins.size) for (const [o, s] of origins) L.push(`- **${o}**: ${s.http} fetch/XHR calls, ${s.ws} websocket(s), ${kb(s.bytes)} of API/socket traffic`);
  else L.push('- No fetch/XHR/WebSocket traffic observed.');
  const blocked = events.filter((e) => e.kind === 'blocked');
  if (blocked.length) {
    L.push('', '### Blocked (the game tried to reach these; ZERO refused)', '');
    const seen = new Set<string>();
    for (const b of blocked) {
      const key = `${new URL(b.url).host}|${b.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      L.push(`- ${b.url.slice(0, 100)}  (${b.reason})`);
    }
  }
  const http = events.filter((e) => e.kind === 'http');
  if (http.length) {
    L.push('', '### API calls', '');
    const byPath = new Map<string, number>();
    for (const e of http) {
      const u = new URL(e.url);
      const k = `${e.method} ${u.pathname}`;
      byPath.set(k, (byPath.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byPath].sort((a, b) => b[1] - a[1]).slice(0, 15)) L.push(`- ${k}  ×${n}`);
  }
  const ws = wsStats(events);
  for (const s of ws) {
    const secs = Math.max(s.spanMs / 1000, 1);
    L.push('', `### WebSocket ${s.url}`, '');
    L.push(`- Sent ${s.sent} frames (${kb(s.sentBytes)}), received ${s.recv} frames (${kb(s.recvBytes)}) over ${(s.spanMs / 1000).toFixed(1)}s`);
    L.push(`- Rate: ↑${(s.sent / secs).toFixed(1)}/s  ↓${(s.recv / secs).toFixed(1)}/s  ·  ${s.binary} binary / ${s.text} text frames${s.closed !== undefined ? `  ·  closed with ${s.closed}` : ''}`);
    for (const sm of s.samples) L.push(`  - \`${sm.replace(/`/g, "'")}\``);
    if (s.recv / secs > 30) findings.push(`WebSocket ${new URL(s.url).host} receives ~${(s.recv / secs).toFixed(0)} frames/s: consider batching/delta updates or lowering the server tick for non-critical state.`);
    if (s.text > s.binary && s.recvBytes / Math.max(s.recv, 1) > 400) findings.push(`WebSocket ${new URL(s.url).host} sends large text frames (avg ${(s.recvBytes / Math.max(s.recv, 1)).toFixed(0)} B): a binary format (MessagePack/protobuf/flatbuffers) would shrink them.`);
    if (s.closed !== undefined && s.closed !== 1000 && s.closed !== 1005) findings.push(`WebSocket ${new URL(s.url).host} closed with code ${s.closed}: check for unexpected disconnects.`);
  }
  L.push('');

  // ---- WebRTC
  const rtc = rtcSummary(events);
  if (rtc.pcs.length || rtc.media.length) {
    L.push('## WebRTC', '');
    for (const p of rtc.pcs) {
      const stun = p.servers.filter((s) => /^stuns?:/i.test(s));
      const turn = p.servers.filter((s) => /^turns?:/i.test(s));
      L.push(`### Peer connection ${p.id}`, '');
      L.push(`- ICE servers used: ${p.servers.join(', ') || 'none'}${p.requested.length > p.servers.length ? `  (requested ${p.requested.length}; ${p.requested.length - p.servers.length} filtered by the allowlist)` : ''}`);
      L.push(`- States: ${p.states.join(' → ') || 'none seen'}`);
      L.push(`- ICE candidates by type/protocol: ${Object.entries(p.ice).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`);
      for (const c of p.channels) {
        L.push(`- Data channel **${c.label}** ${c.opts}: ↑${c.sent} msgs (${kb(c.sentBytes)}), ↓${c.recv} msgs (${kb(c.recvBytes)}), largest ${c.maxMsg} B${c.closed ? ', closed/errored' : ''}`);
        if (c.maxMsg > 16384) findings.push(`Data channel "${c.label}" sent a ${kb(c.maxMsg)} message. Messages over ~16 KB are not interoperable across browsers (SCTP limit); chunk them.`);
        if (c.opts.includes('"ordered":true') && c.opts.includes('"maxRetransmits":null') && c.sent + c.recv > 200) findings.push(`Data channel "${c.label}" is reliable+ordered with high message volume. For frequent position/state updates, an unordered channel with maxRetransmits: 0 avoids head-of-line blocking.`);
      }
      if (stun.length && !turn.length && !p.requested.some((s) => /^turns?:/i.test(s))) findings.push(`${p.id} uses STUN only (no TURN). Players behind symmetric NAT or strict firewalls (often 10-20% of users) will fail to connect; add a TURN server.`);
      if (p.states.some((s) => s === 'failed' || s === 'ice:failed')) findings.push(`${p.id} reached a failed state. Check ICE server reachability (note: ZERO filters non-allowlisted ICE servers, which can cause this in a fork run).`);
      L.push('');
    }
    if (rtc.media.length) L.push(`- getUserMedia requested: ${rtc.media.join(' ')}`, '');
    L.push('_ZERO cannot block or inspect direct peer-to-peer (UDP) traffic. It records signalling-side facts and data-channel messages, and filters ICE (STUN/TURN) servers to your allowlist. ICE candidate addresses are never recorded._', '');
  }

  // ---- services
  if (services.length) {
    L.push('## Backend & hosting services', '');
    for (const s of services) {
      L.push(`- **${s.service}**: ${s.roles.join(', ')}${s.projects.length ? `  ·  project(s): ${s.projects.join(', ')}` : ''}  ·  ${s.live ? 'seen live' : 'referenced in code only'}${s.blocked ? '  ·  traffic blocked by allowlist' : ''}`);
      for (const e of s.evidence) L.push(`  - ${e}`);
      if (s.blocked && s.origins.length) findings.push(`${s.service} traffic was blocked. If it is your project, run ${s.origins.slice(0, 3).map((o) => `\`zero allow ${o} --asset\``).join(' / ')} and re-fork to capture the calls.`);
    }
    L.push('');
    if (services.some((s) => s.service === 'Firebase')) findings.push('Firebase detected: the client config (apiKey etc.) is public by design, so your Security Rules are the only protection. Confirm Realtime Database/Firestore/Storage rules deny unauthenticated writes, and test them with the Emulator Suite.');
    const fns = services.find((s) => s.service === 'Netlify' && s.roles.includes('Functions'));
    if (fns) findings.push('Netlify Functions are called by the game. Check cold-start latency on first call and keep per-request payloads small; server-side validation matters because every function is publicly callable.');
  }

  // ---- findings (second-person improvements)
  const big = man.assets.filter((a) => a.bytes > 1048576);
  if (big.length) findings.push(`${big.length} asset(s) over 1 MB (largest: ${big.sort((a, b) => b.bytes - a.bytes)[0]!.file}, ${mb(big[0]!.bytes)}): split, stream, or compress for faster first load.`);
  const unc = man.assets.filter((a) => TEXTY.has(a.kind) && a.bytes > 50 * 1024 && !a.encoding);
  if (unc.length) findings.push(`${unc.length} text/wasm asset(s) over 50 KB served without gzip/brotli (e.g. ${unc[0]!.file}). Enable compression on the server/CDN.`);
  const nocache = man.assets.filter((a) => CACHEABLE.has(a.kind) && !/max-age|immutable|s-maxage/i.test(a.cacheControl));
  if (nocache.length) findings.push(`${nocache.length} static asset(s) have no long-lived Cache-Control (e.g. ${nocache[0]!.file}). Returning players re-download them.`);
  const bySha = new Map<string, string[]>();
  for (const a of man.assets) bySha.set(a.sha256, [...(bySha.get(a.sha256) ?? []), a.file]);
  const dupes = [...bySha.values()].filter((v) => v.length > 1);
  if (dupes.length) findings.push(`${dupes.length} duplicated file group(s) with identical contents (e.g. ${dupes[0]!.slice(0, 2).join(' = ')}). Deduplicate.`);
  const wav = man.assets.filter((a) => /\.(wav|aiff?)$/i.test(a.file) && a.bytes > 200 * 1024);
  if (wav.length) findings.push(`${wav.length} uncompressed audio file(s) (e.g. ${wav[0]!.file}, ${kb(wav[0]!.bytes)}): OGG/Opus or MP3 is typically 5-10x smaller.`);
  const bigPng = man.assets.filter((a) => a.kind === 'image' && /\.(png|bmp|tga)$/i.test(a.file) && a.bytes > 500 * 1024);
  if (bigPng.length) findings.push(`${bigPng.length} large PNG/BMP image(s) (e.g. ${bigPng[0]!.file}, ${kb(bigPng[0]!.bytes)}): WebP/AVIF, or KTX2/Basis for GPU textures, would cut size and VRAM.`);
  const legacyModel = man.assets.filter((a) => /\.(obj|fbx|dae)$/i.test(a.file));
  if (legacyModel.length) findings.push(`${legacyModel.length} legacy model file(s) (.obj/.fbx/.dae): glTF/GLB (with Draco or meshopt) loads faster on the web.`);
  const heavy = totalBytes > 50 * 1048576;
  if (heavy) findings.push(`Total payload is ${mb(totalBytes)}: consider lazy-loading levels/audio after the first playable frame.`);
  if (rt && rt.localStorageKeys.length === 0 && rt.indexedDB.length === 0) findings.push('No save data detected after the play session (may be fine if progress is server-side).');
  if (blocked.some((b) => b.reason === 'origin not allowed')) findings.push('The game contacts origins outside your allowlist (listed above). If they are yours, `zero allow` them to capture that traffic; if not, note the third-party dependency.');

  L.push('## Second-person improvements', '');
  const uniq = [...new Set(findings)];
  if (uniq.length) uniq.forEach((f, i) => L.push(`${i + 1}. ${f}`));
  else L.push('Nothing flagged. Run a longer `--play` session to exercise more of the game.');
  L.push('');
  return L.join('\n');
}
