import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assertAuthorized, loadConfig, normalizeOrigin, parseHttpsUrl, ROOT, saveConfig } from './guard.js';
import { launchDisposable } from './browser.js';
import { attachCapture, redactUrl, type NetEvent } from './capture.js';
import { crawl } from './crawl.js';
import { classify } from './classify.js';
import { keyOf, rewriteCss, rewriteHtml, type Resolver } from './rewrite.js';
import { createForkDir, listForks, localPathFor, sanitizeTitle, sha256, writeFileDeep, type Manifest } from './store.js';
import { buildReport } from './report.js';
import { serveFork } from './serve.js';
import { detectServices } from './services.js';
import { loadFlow } from './flow.js';
import type { RuntimeProbe } from './probe.js';

const USAGE = `ZERO: fork your own games/sites into a clean ZEROED folder, then study them

  zero allow <https-origin>        authorize an origin (yours) before forking
  zero allow <origin> --asset      also let forks reach this origin (your CDN, Firebase project, STUN/TURN host)
  zero allowed                     show the allowlist
  zero fork <https-url> [opts]     capture pages, assets, server traffic, runtime info
      --game                       game preset: depth 0, 45s play session with input
      --play <sec>                 stay on the landing page this long (lazy assets, sockets)
      --no-input                   observe only: no click/Space/Enter during play
      --script <flow.json>         run a scripted flow (clicks, keys, waits) during play; defaults to 60s
      --depth <n> --max-pages <n>  crawl limits (default from zero.config.json)
      --html raw|rendered          page source to save: original server HTML (default) or the post-JS DOM
      --no-clean                   keep analytics/trackers
      --out <dir>                  output root (default ZERO/ZEROED)
  zero list                        list forks
  zero report <fork>               print the improvement report for a fork
  zero serve <fork> [--port N] [--isolate]   play a fork at http://127.0.0.1:N
`;

type Opts = {
  game?: boolean; play?: string; 'no-input'?: boolean; depth?: string; 'max-pages'?: string;
  'no-clean'?: boolean; out?: string; port?: string; isolate?: boolean; asset?: boolean; script?: string; html?: string;
};

const outRootOf = (o: Opts) => resolve(o.out ?? `${ROOT}/ZEROED`);

async function fork(urlArg: string, opts: Opts): Promise<void> {
  const cfg = await loadConfig();
  const start = parseHttpsUrl(urlArg);
  assertAuthorized(start, cfg);

  const depth = opts.depth ? Number(opts.depth) : opts.game || opts.script ? 0 : cfg.depth;
  const maxPages = opts['max-pages'] ? Number(opts['max-pages']) : cfg.maxPages;
  if (opts.script && opts['no-input']) throw new Error('--script sends input, so it cannot be combined with --no-input.');
  if (opts.html && opts.html !== 'raw' && opts.html !== 'rendered') throw new Error('--html must be "raw" (default) or "rendered".');
  const script = opts.script ? await loadFlow(resolve(opts.script)) : undefined;
  const playSec = opts.play ? Number(opts.play) : opts.game || script ? (script ? 60 : 45) : 0;
  const clean = opts['no-clean'] ? false : cfg.clean;
  const outRoot = outRootOf(opts);
  const log = (m: string) => console.log(m);

  const allowedOrigins = new Set<string>([start.origin, ...cfg.assetOrigins]);
  const { browser, context } = await launchDisposable();
  try {
    log(`Forking ${start.href} (depth ${depth}, max ${maxPages} pages, play ${playSec}s, clean=${clean})`);
    const cap = attachCapture(context, allowedOrigins, cfg.maxBytes, clean);
    const pages = await crawl(context, {
      start, depth, maxPages, timeoutMs: cfg.pageTimeoutMs, playMs: playSec * 1000, input: !opts['no-input'], script, log,
    });
    if (!pages.length) throw new Error('No pages could be captured.');

    const title = pages[0]!.title;
    const dir = await createForkDir(outRoot, sanitizeTitle(title, start.hostname));

    const map: Resolver = new Map();
    for (const p of pages) map.set(keyOf(p.url), { local: localPathFor(p.url, start.origin, true) });
    for (const [k, a] of cap.assets) if (!map.has(k)) map.set(k, { local: localPathFor(a.url, start.origin, false) });

    const manifest: Manifest = { source: start.href, title, forkedAt: new Date().toISOString(), pages: [], assets: [], skipped: cap.skipped, cleaned: [] };

    for (const p of pages) {
      const local = map.get(keyOf(p.url))!.local;
      // Default: original server HTML (faithful to your source). `--html rendered` saves the post-JS DOM instead.
      const original = opts.html === 'rendered' ? undefined : cap.docs.get(keyOf(p.url));
      if (opts.html !== 'rendered' && !original) log(`  note: no original HTML for ${p.url.pathname}, saved rendered DOM instead`);
      const r = rewriteHtml(original ?? p.html, p.url.href, local, map, clean);
      await writeFileDeep(dir, local, r.html);
      manifest.pages.push({ url: p.url.href, file: local });
      manifest.cleaned.push(...r.cleaned);
    }
    const summary: Record<string, { count: number; bytes: number }> = {};
    for (const [k, a] of cap.assets) {
      const local = map.get(k)!.local;
      let body: Buffer | string = a.body;
      if (a.contentType.includes('text/css')) body = rewriteCss(a.body.toString('utf8'), a.url.href, local, map);
      await writeFileDeep(dir, local, body);
      const kind = classify(a.url, a.contentType);
      const s = (summary[kind] ??= { count: 0, bytes: 0 });
      s.count++;
      s.bytes += a.body.length;
      manifest.assets.push({
        url: redactUrl(a.url.href), file: local, sha256: sha256(a.body), bytes: a.body.length, kind,
        contentType: a.contentType, encoding: a.encoding, cacheControl: a.cacheControl,
      });
    }
    manifest.summary = summary;
    const runtime = pages[0]!.probe ?? null;

    await writeFileDeep(dir, 'zero.manifest.json', JSON.stringify(manifest, null, 2));
    await writeFileDeep(dir, 'zero.network.jsonl', cap.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (runtime) await writeFileDeep(dir, 'zero.runtime.json', JSON.stringify(runtime, null, 2));
    // Service detection: live traffic + blocked attempts + header fingerprints + code references + SDK globals.
    const httpish = (u: string) => /^(https?|wss?):/i.test(u);
    const texts: string[] = pages.map((p) => p.html);
    for (const a of cap.assets.values()) {
      if (a.body.length < 3_000_000 && /javascript|json|html|text/.test(a.contentType)) texts.push(a.body.toString('utf8'));
    }
    const services = detectServices({
      traffic: [...manifest.pages.map((p) => p.url), ...manifest.assets.map((a) => a.url), ...cap.events.filter((e) => e.kind !== 'blocked' && httpish(e.url)).map((e) => e.url)],
      blocked: cap.events.filter((e) => e.kind === 'blocked' && httpish(e.url)).map((e) => e.url),
      headers: cap.hints,
      texts,
      globals: runtime?.serviceGlobals ?? [],
    });
    await writeFileDeep(dir, 'zero.services.json', JSON.stringify(services, null, 2));
    const report = buildReport(manifest, cap.events, runtime, services);
    await writeFileDeep(dir, 'zero.report.md', report);

    log(`\nZEROED -> ${dir}`);
    log(`  ${manifest.pages.length} pages, ${manifest.assets.length} assets, ${cap.events.filter((e) => e.kind.startsWith('ws-')).length} socket events, ${manifest.skipped.length} blocked/skipped, ${manifest.cleaned.length} tracker items removed`);
    log(`  report: ${join(dir, 'zero.report.md')}`);
    const tip = report.split('## Second-person improvements')[1]?.trim();
    if (tip) log(`\nSecond-person improvements:\n${tip}`);
  } finally {
    await browser.close();
  }
}

function forkDir(name: string, opts: Opts): string {
  const direct = resolve(name);
  if (existsSync(join(direct, 'zero.manifest.json'))) return direct;
  const inRoot = join(outRootOf(opts), name);
  if (existsSync(join(inRoot, 'zero.manifest.json'))) return inRoot;
  throw new Error(`No fork named "${name}". Run \`zero list\`.`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      game: { type: 'boolean' }, play: { type: 'string' }, 'no-input': { type: 'boolean' },
      depth: { type: 'string' }, 'max-pages': { type: 'string' }, 'no-clean': { type: 'boolean' },
      out: { type: 'string' }, port: { type: 'string' }, isolate: { type: 'boolean' }, asset: { type: 'boolean' }, script: { type: 'string' }, html: { type: 'string' },
    },
  });
  const [cmd, arg] = positionals;
  if (cmd === 'fork' && arg) return fork(arg, values);
  if (cmd === 'allow' && arg) {
    const origin = normalizeOrigin(arg);
    const cfg = await loadConfig();
    const list = values.asset ? cfg.assetOrigins : cfg.allow;
    if (!list.includes(origin)) list.push(origin);
    await saveConfig(cfg);
    console.log(`Allowed${values.asset ? ' (assets/sockets/ICE only, never a fork target)' : ''}: ${origin}`);
    return;
  }
  if (cmd === 'allowed') {
    const cfg = await loadConfig();
    console.log(cfg.allow.length ? `Fork targets:\n  ${cfg.allow.join('\n  ')}` : '(empty: run `zero allow <origin>`)');
    if (cfg.assetOrigins.length) console.log(`Asset/socket origins:\n  ${cfg.assetOrigins.join('\n  ')}`);
    return;
  }
  if (cmd === 'list') {
    const forks = await listForks(outRootOf(values));
    if (!forks.length) console.log('No forks yet.');
    for (const f of forks) console.log(`${f.dir}\n  ${f.manifest.source}  ${f.manifest.forkedAt}  ${f.manifest.pages.length}p/${f.manifest.assets.length}a`);
    return;
  }
  if (cmd === 'report' && arg) {
    console.log(await readFile(join(forkDir(arg, values), 'zero.report.md'), 'utf8'));
    return;
  }
  if (cmd === 'serve' && arg) {
    const dir = forkDir(arg, values);
    const port = values.port ? Number(values.port) : 8080;
    await serveFork(dir, port, !!values.isolate);
    console.log(`Serving ${dir}\n  http://127.0.0.1:${port}/${values.isolate ? '  (cross-origin isolated)' : ''}\n  Ctrl+C to stop`);
    return; // server keeps the process alive
  }
  console.log(USAGE);
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

export type { NetEvent, RuntimeProbe };
