import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { posix, join, dirname } from 'node:path';

export function sanitizeTitle(title: string, fallback: string): string {
  const t = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  return t || fallback;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Create ZEROED/<name>, de-colliding with " (2)", " (3)"... */
export async function createForkDir(outRoot: string, name: string): Promise<string> {
  await mkdir(outRoot, { recursive: true });
  let dir = join(outRoot, name);
  for (let n = 2; await exists(dir); n++) dir = join(outRoot, `${name} (${n})`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Map a URL to a relative local file path (posix, no leading slash). */
export function localPathFor(u: URL, startOrigin: string, isPage: boolean): string {
  const prefix = u.origin === startOrigin ? '' : `_ext/${u.host.replace(/[:]/g, '_')}/`;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    p = u.pathname;
  }
  const segs = p.split('/').filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_'));
  let file = segs.join('/');
  const last = segs[segs.length - 1] ?? '';
  const hasExt = posix.extname(last) !== '';
  if (p.endsWith('/') || segs.length === 0) file = posix.join(file, 'index.html');
  else if (isPage && !hasExt) file = posix.join(file, 'index.html');
  if (u.search) {
    const ext = posix.extname(file);
    file = `${file.slice(0, file.length - ext.length)}~${sha256(u.search).slice(0, 6)}${ext}`;
  }
  return prefix + file;
}

export async function writeFileDeep(root: string, rel: string, data: Buffer | string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
}

export interface Manifest {
  source: string;
  title: string;
  forkedAt: string;
  pages: { url: string; file: string }[];
  assets: { url: string; file: string; sha256: string; bytes: number; kind: string; contentType: string; encoding: string; cacheControl: string }[];
  summary?: Record<string, { count: number; bytes: number }>;
  skipped: { url: string; reason: string }[];
  cleaned: string[];
}

export async function listForks(outRoot: string): Promise<{ dir: string; manifest: Manifest }[]> {
  if (!(await exists(outRoot))) return [];
  const out: { dir: string; manifest: Manifest }[] = [];
  for (const d of await readdir(outRoot)) {
    const mp = join(outRoot, d, 'zero.manifest.json');
    if (await exists(mp)) out.push({ dir: d, manifest: JSON.parse(await readFile(mp, 'utf8')) as Manifest });
  }
  return out;
}
