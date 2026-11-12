import type { BrowserContext, Page } from 'playwright';
import { keyOf } from './rewrite.js';
import { probe, type RuntimeProbe } from './probe.js';
import { runFlow, type Step } from './flow.js';

export interface RenderedPage { url: URL; html: string; title: string; depth: number; probe?: RuntimeProbe }

export interface CrawlOptions {
  start: URL;
  depth: number;
  maxPages: number;
  timeoutMs: number;
  playMs: number; // stay on the landing page this long, exercising it (0 = off)
  input: boolean; // send click/Space/Enter during the play session
  script?: Step[]; // scripted flow (replaces the generic poke)
  log: (m: string) => void;
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 600);
        y += 600;
        if (y >= document.body.scrollHeight + 600) {
          clearInterval(t);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
}

/** Poke the page the way a first-time player would: clear "click to start" gates, then idle. */
async function poke(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(vp.width / 2, vp.height / 2).catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
}

async function playSession(page: Page, o: CrawlOptions): Promise<void> {
  o.log(`  play session: ${Math.round(o.playMs / 1000)}s${o.script ? ` (flow, ${o.script.length} steps)` : o.input ? ' (with input)' : ' (observe only)'}`);
  const start = Date.now();
  if (o.script) {
    await runFlow(page, o.script, start + o.playMs, o.log);
    const left = start + o.playMs - Date.now();
    if (left > 0) await page.waitForTimeout(left); // keep observing traffic after the flow ends
    return;
  }
  let pokes = 0;
  while (Date.now() - start < o.playMs) {
    if (o.input && pokes < 3 && Date.now() - start >= (o.playMs / 3) * pokes) {
      await poke(page);
      pokes++;
    }
    await page.waitForTimeout(500);
  }
}

/** BFS over same-origin links; returns the rendered DOM for each page. */
export async function crawl(context: BrowserContext, o: CrawlOptions): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];
  const seen = new Set<string>([keyOf(o.start)]);
  const queue: { url: URL; depth: number }[] = [{ url: o.start, depth: 0 }];
  const page = await context.newPage();

  while (queue.length && pages.length < o.maxPages) {
    const { url, depth } = queue.shift()!;
    try {
      // 'load' + best-effort idle: games with persistent sockets/polling never go fully idle.
      const res = await page.goto(url.href, { waitUntil: 'load', timeout: o.timeoutMs });
      if (!res || !res.ok()) {
        o.log(`  skip ${url.href} (${res?.status() ?? 'no response'})`);
        continue;
      }
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('html')) continue;
      const final = new URL(page.url());
      if (final.origin !== o.start.origin) {
        o.log(`  skip ${url.href} (redirected off-origin)`);
        continue;
      }
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await autoScroll(page).catch(() => {});

      const isLanding = pages.length === 0;
      if (isLanding && o.playMs > 0) await playSession(page, o);
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

      const html = await page.content();
      const title = await page.title();
      const rp: RenderedPage = { url: final, html, title, depth };
      if (isLanding) rp.probe = await probe(page).catch((e) => { o.log("  probe failed: " + String(e).split("\n")[0]); return undefined; });
      seen.add(keyOf(final));
      pages.push(rp);
      o.log(`  [${pages.length}] ${final.pathname}${final.search}`);

      if (depth < o.depth) {
        const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
        for (const h of hrefs) {
          let u: URL;
          try {
            u = new URL(h);
          } catch {
            continue;
          }
          if (u.origin !== o.start.origin) continue;
          u.hash = '';
          const k = keyOf(u);
          if (seen.has(k)) continue;
          seen.add(k);
          queue.push({ url: u, depth: depth + 1 });
        }
      }
    } catch (e) {
      o.log(`  fail ${url.href}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  await page.close();
  return pages;
}
