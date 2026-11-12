import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export interface Config {
  allow: string[];
  assetOrigins: string[];
  clean: boolean;
  maxPages: number;
  depth: number;
  maxBytes: number;
  pageTimeoutMs: number;
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'zero.config.json');

export async function loadConfig(): Promise<Config> {
  // zero.config.json is local state (your allowlist); first run copies the committed example.
  if (!existsSync(CONFIG_PATH)) await copyFile(join(ROOT, 'zero.config.example.json'), CONFIG_PATH);
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Config;
}

export async function saveConfig(c: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
}

/** Parse and validate a start URL: https only. Returns the URL or throws. */
export function parseHttpsUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (u.protocol !== 'https:') throw new Error(`Refused: only https:// is allowed (got ${u.protocol}//)`);
  return u;
}

/** The safety rail: the start origin must be explicitly allowlisted. */
export function assertAuthorized(u: URL, cfg: Config): void {
  if (!cfg.allow.includes(u.origin)) {
    throw new Error(
      `Refused: ${u.origin} is not on the allowlist. Only fork sites you own or are authorized to copy.\n` +
        `If it is yours, run: zero allow ${u.origin}`,
    );
  }
}

export function normalizeOrigin(input: string): string {
  return parseHttpsUrl(input).origin;
}
