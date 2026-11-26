import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { isTrackerUrl } from './clean.js';
import { keyOf } from './rewrite.js';

export interface Captured {
  url: URL;
  contentType: string;
  body: Buffer;
  encoding: string;
  cacheControl: string;
}

export type NetKind =
  | 'http' | 'ws-open' | 'ws-sent' | 'ws-recv' | 'ws-close' | 'blocked'
  | 'rtc-open' | 'rtc-channel' | 'rtc-sent' | 'rtc-recv' | 'rtc-state' | 'rtc-ice' | 'rtc-media';
/** Large packaged binaries that the inspector cache tends to evict (e.g. gta3-data.data.03, game.pak, level.bin.2). */
const BIG_BINARY = /\.(data|pak|pck|bin|zip|img)(\.\d+)?$/i;
const RTC_KINDS = new Set<string>(['rtc-open', 'rtc-channel', 'rtc-sent', 'rtc-recv', 'rtc-state', 'rtc-ice', 'rtc-media']);
// Response headers worth keeping as hosting/backend fingerprints.
const HINT_HEADERS = ['server', 'x-nf-request-id', 'x-vercel-id', 'cf-ray', 'x-amz-cf-id', 'x-amz-request-id', 'x-github-request-id', 'x-served-by', 'x-powered-by'];

export interface NetEvent {
  t: number; // ms since capture start
  kind: NetKind;
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
  size?: number; // bytes (response body, or ws frame)
  binary?: boolean; // ws frame: binary (payload is base64) vs text
  payload?: string; // preview, first 512 bytes
  reason?: string; // blocked: why
}

export interface Capture {
  assets: Map<string, Captured>;
  skipped: { url: string; reason: string }[];
  events: NetEvent[];
  docs: Map<string, string>; // keyOf(url) -> original HTML document body
  hints: Record<string, string>; // fingerprint headers seen on allowed-origin responses
  bytes: () => number;
}

const PREVIEW = 512;
const SENSITIVE_PARAM = /key|token|secret|auth|pass|sig|jwt|credential|session|bearer/i;

/** Replace the value of key/token-like query parameters so secrets never reach logs, manifests or reports. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.search) return raw;
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, 'REDACTED');
    return u.toString();
  } catch {
    return raw;
  }
}

const JSON_SECRET = /("(?:[\w-]*(?:token|apikey|api_key|secret|password|passwd|authorization|jwt|credential)[\w-]*)"\s*:\s*")[^"]*(")/gi;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** Scrub secrets from text previews (socket frames, request bodies) before they are stored. */
export function redactText(s: string): string {
  return s.replace(JSON_SECRET, '$1REDACTED$2').replace(JWT, 'REDACTED_JWT');
}

function preview(p: string | Buffer): { payload: string; binary: boolean; size: number } {
  if (typeof p === 'string') return { payload: redactText(p.slice(0, PREVIEW)), binary: false, size: Buffer.byteLength(p) };
  return { payload: p.subarray(0, PREVIEW).toString('base64'), binary: true, size: p.length };
}

/**
 * Wire a context to:
 *  (a) allow only https:// / wss:// traffic to allowlisted origins (everything else is blocked AND logged,
 *      so you can see which servers the game tried to reach),
 *  (b) record every successful GET sub-resource body (assets),
 *  (c) log fetch/XHR calls and every WebSocket frame, in both directions.
 */
export function attachCapture(context: BrowserContext, allowedOrigins: Set<string>, maxBytes: number, clean: boolean): Capture {
  const assets = new Map<string, Captured>();
  const skipped: { url: string; reason: string }[] = [];
  const events: NetEvent[] = [];
  const hints: Record<string, string> = {};
  const docs = new Map<string, string>();
  const t0 = Date.now();
  let total = 0;
  const ev = (e: Omit<NetEvent, 't'>) => events.push({ t: Date.now() - t0, ...e, url: redactUrl(e.url) });
  const block = (url: string, reason: string) => {
    skipped.push({ url: redactUrl(url), reason });
    ev({ kind: 'blocked', url, reason });
  };

  context.route('**/*', async (route) => {
    const url = route.request().url();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return route.abort();
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (u.protocol !== 'https:') {
      block(url, 'not https');
      return route.abort();
    }
    if (!allowedOrigins.has(u.origin)) {
      block(url, 'origin not allowed');
      return route.abort();
    }
    if (clean && isTrackerUrl(url)) {
      block(url, 'tracker');
      return route.abort();
    }
    // Big binary packages (file_packager chunks, .pak/.bin/.zip): Chromium evicts their bodies from the
    // inspector cache before the response handler can read them, so read them here, from the page's own
    // request (same headers the browser sent), save them, and hand the same bytes back to the page.
    if (route.request().method() === 'GET' && BIG_BINARY.test(u.pathname)) {
      try {
        const res = await route.fetch();
        const body = await res.body();
        const key = keyOf(u);
        if (res.status() >= 200 && res.status() < 300 && !assets.has(key)) {
          if (total + body.length > maxBytes) {
            skipped.push({ url: redactUrl(url), reason: 'byte cap reached' });
          } else {
            total += body.length;
            const h = res.headers();
            assets.set(key, { url: u, contentType: h['content-type'] ?? '', body, encoding: h['content-encoding'] ?? '', cacheControl: h['cache-control'] ?? '' });
          }
        }
        ev({ kind: 'http', url, method: 'GET', status: res.status(), resourceType: route.request().resourceType(), size: body.length });
        return route.fulfill({ response: res, body });
      } catch (e) {
        skipped.push({ url: redactUrl(url), reason: `route fetch failed: ${e instanceof Error ? e.message.split('\n')[0]!.slice(0, 120) : String(e)}` });
        return route.fallback();
      }
    }
    return route.continue();
  });

  // WebSockets: wss:// to allowlisted hosts only; frames proxied and logged both ways.
  context.routeWebSocket(/.*/, (ws) => {
    const raw = ws.url();
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ws.close();
      return;
    }
    if (u.protocol !== 'wss:') {
      block(raw, 'websocket not wss');
      ws.close({ code: 1008, reason: 'blocked by ZERO' });
      return;
    }
    if (!allowedOrigins.has(`https://${u.host}`)) {
      block(raw, 'origin not allowed');
      ws.close({ code: 1008, reason: 'blocked by ZERO' });
      return;
    }
    ev({ kind: 'ws-open', url: raw });
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      ev({ kind: 'ws-sent', url: raw, ...preview(m) });
      server.send(m);
    });
    server.onMessage((m) => {
      ev({ kind: 'ws-recv', url: raw, ...preview(m) });
      ws.send(m);
    });
    ws.onClose((code) => {
      ev({ kind: 'ws-close', url: raw, status: code });
      server.close();
    });
    server.onClose(() => ws.close());
  });

  // WebRTC: the page-side hook (rtc-inject.js) reports through this binding. Page data is untrusted,
  // so kinds are whitelisted and every string is length-capped.
  const allowedHosts = [...allowedOrigins].map((o) => new URL(o).hostname.toLowerCase());
  const cap = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  void context.exposeBinding('__zeroRtcReport', (_src, e: Record<string, unknown>) => {
    const kind = String(e?.kind);
    if (kind === 'blocked') return block(cap(e.url, 200) ?? '', cap(e.reason, 80) ?? 'ice server not allowed');
    if (!RTC_KINDS.has(kind)) return;
    ev({
      kind: kind as NetKind,
      url: cap(e.url, 200) ?? 'rtc:?',
      size: typeof e.size === 'number' ? e.size : undefined,
      binary: typeof e.binary === 'boolean' ? e.binary : undefined,
      payload: redactText(cap(e.payload, 700) ?? '') || undefined,
    });
  });
  void context.addInitScript({
    content: readFileSync(new URL('./rtc-inject.js', import.meta.url), 'utf8').replace('__ALLOWED_HOSTS__', JSON.stringify(allowedHosts)),
  });

  context.on('response', async (res) => {
    const req = res.request();
    const rt = req.resourceType();
    let u: URL;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.protocol !== 'https:' || !allowedOrigins.has(u.origin)) return;
    const rh = res.headers();
    for (const name of HINT_HEADERS) if (rh[name] && !hints[name]) hints[name] = rh[name]!.slice(0, 100);
    let body: Buffer | null = null;
    let bodyErr = '';
    for (let attempt = 0; attempt < 3 && !body; attempt++) {
      try {
        body = await res.body();
      } catch (e) {
        /* redirect / aborted, or the browser already dropped a large body: retry briefly, then record why */
        bodyErr = e instanceof Error ? e.message.split('\n')[0]!.slice(0, 120) : String(e);
        if (res.status() >= 300 && res.status() < 400) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!body && req.method() === 'GET' && res.status() >= 200 && res.status() < 300 && rt !== 'document' && !assets.has(keyOf(u))) {
      skipped.push({ url: redactUrl(res.url()), reason: `body unavailable: ${bodyErr || 'empty'}` });
    }
    if (rt === 'fetch' || rt === 'xhr') {
      ev({ kind: 'http', url: res.url(), method: req.method(), status: res.status(), resourceType: rt, size: body?.length, payload: redactText(req.postData()?.slice(0, PREVIEW) ?? '') || undefined });
    }
    if (rt === 'document') {
      // Keep the ORIGINAL server HTML: replaying scripts over a rendered DOM duplicates JS-created UI.
      if (body && req.method() === 'GET' && res.status() >= 200 && res.status() < 300 && /html/i.test(rh['content-type'] ?? '')) docs.set(keyOf(u), body.toString('utf8'));
      return;
    }
    if (req.method() !== 'GET') return;
    if (res.status() < 200 || res.status() >= 300 || !body) return;
    const key = keyOf(u);
    if (assets.has(key)) return;
    if (total + body.length > maxBytes) {
      skipped.push({ url: res.url(), reason: 'byte cap reached' });
      return;
    }
    total += body.length;
    const h = res.headers();
    assets.set(key, {
      url: u,
      contentType: h['content-type'] ?? '',
      body,
      encoding: h['content-encoding'] ?? '',
      cacheControl: h['cache-control'] ?? '',
    });
  });

  return { assets, skipped, events, docs, hints, bytes: () => total };
}
