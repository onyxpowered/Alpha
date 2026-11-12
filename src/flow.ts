import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';

/**
 * A flow is a JSON array of steps run inside the play session, e.g.
 *   [{"click":"#startBtn"}, {"wait":3000}, {"repeat":10,"steps":[{"press":"KeyW","hold":500}]}]
 * Actions only act on the game page. Navigation off-origin is impossible anyway (allowlist).
 */
export interface Step {
  wait?: number; // ms (max 30000)
  waitFor?: string; // CSS selector to appear
  click?: string | [number, number]; // CSS selector, or viewport x,y
  clickText?: string; // click first element containing this text
  press?: string; // key name, e.g. "Space", "KeyW", "Enter"
  hold?: number; // with press: hold the key this many ms
  type?: string; // type text (into `into` if given, else the focused element)
  into?: string; // CSS selector for `type`
  mouse?: { move?: [number, number]; down?: boolean; up?: boolean };
  scroll?: number; // wheel delta Y
  timeout?: number; // per-step wait for selectors (default 5000)
  optional?: boolean; // do not abort the flow if this step fails
  repeat?: number; // run `steps` this many times (max 1000)
  steps?: Step[];
}

const KEYS = new Set(['wait', 'waitFor', 'click', 'clickText', 'press', 'hold', 'type', 'into', 'mouse', 'scroll', 'timeout', 'optional', 'repeat', 'steps']);

function validate(steps: unknown, path = 'flow'): Step[] {
  if (!Array.isArray(steps)) throw new Error(`${path} must be an array of steps`);
  steps.forEach((s, i) => {
    const here = `${path}[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${here} must be an object`);
    for (const k of Object.keys(s)) if (!KEYS.has(k)) throw new Error(`${here}: unknown key "${k}" (allowed: ${[...KEYS].join(', ')})`);
    const st = s as Step;
    if (st.repeat !== undefined && (!Number.isInteger(st.repeat) || st.repeat < 1 || st.repeat > 1000)) throw new Error(`${here}: repeat must be 1-1000`);
    if (st.repeat !== undefined && !st.steps) throw new Error(`${here}: repeat needs steps`);
    if (st.steps) validate(st.steps, `${here}.steps`);
  });
  return steps as Step[];
}

export async function loadFlow(file: string): Promise<Step[]> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  return validate(Array.isArray(raw) ? raw : (raw as { steps?: unknown }).steps);
}

class Deadline extends Error {}

async function run(page: Page, s: Step, deadline: number, log: (m: string) => void): Promise<void> {
  if (Date.now() >= deadline) throw new Deadline();
  const timeout = s.timeout ?? 5000;
  try {
    if (s.repeat && s.steps) {
      for (let i = 0; i < s.repeat; i++) for (const c of s.steps) await run(page, c, deadline, log);
      return;
    }
    if (s.wait) await page.waitForTimeout(Math.min(s.wait, 30000, Math.max(deadline - Date.now(), 0)));
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout });
    if (typeof s.click === 'string') await page.click(s.click, { timeout });
    else if (Array.isArray(s.click)) await page.mouse.click(s.click[0], s.click[1]);
    if (s.clickText) await page.getByText(s.clickText).first().click({ timeout });
    if (s.press) {
      if (s.hold) {
        await page.keyboard.down(s.press);
        await page.waitForTimeout(Math.min(s.hold, 10000));
        await page.keyboard.up(s.press);
      } else await page.keyboard.press(s.press);
    }
    if (s.type !== undefined) {
      if (s.into) await page.fill(s.into, s.type, { timeout });
      else await page.keyboard.type(s.type);
    }
    if (s.mouse?.move) await page.mouse.move(s.mouse.move[0], s.mouse.move[1]);
    if (s.mouse?.down) await page.mouse.down();
    if (s.mouse?.up) await page.mouse.up();
    if (s.scroll) await page.mouse.wheel(0, s.scroll);
  } catch (e) {
    if (e instanceof Deadline) throw e;
    if (s.optional) {
      log(`  flow: optional step skipped (${JSON.stringify(s).slice(0, 80)})`);
      return;
    }
    throw new Error(`step ${JSON.stringify(s).slice(0, 100)} failed: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Run a flow until it finishes, fails, or the deadline passes. Never throws. */
export async function runFlow(page: Page, steps: Step[], deadline: number, log: (m: string) => void): Promise<void> {
  try {
    for (const s of steps) await run(page, s, deadline, log);
    log('  flow: finished');
  } catch (e) {
    log(e instanceof Deadline ? '  flow: stopped at the play-time limit' : `  flow: aborted, ${(e as Error).message}`);
  }
}
