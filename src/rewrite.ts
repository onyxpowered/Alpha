import * as cheerio from 'cheerio';
import { posix } from 'node:path';
import { cleanDom } from './clean.js';

export const keyOf = (u: URL): string => u.origin + u.pathname + u.search;

export interface Target { local: string }
export type Resolver = Map<string, Target>; // keyOf(url) -> local file

function ref(raw: string, base: string, fromLocal: string, map: Resolver): string {
  const r = raw.trim();
  if (!r || r.startsWith('#') || /^(data|javascript|mailto|tel|blob):/i.test(r)) return raw;
  let u: URL;
  try {
    u = new URL(r, base);
  } catch {
    return raw;
  }
  const t = map.get(keyOf(u));
  if (!t) return raw;
  const rel = posix.relative(posix.dirname(fromLocal), t.local) || posix.basename(t.local);
  return encodeURI(rel) + u.hash;
}

export function rewriteCss(css: string, base: string, fromLocal: string, map: Resolver): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${ref(u, base, fromLocal, map)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q: string, u: string) => `@import ${q}${ref(u, base, fromLocal, map)}${q}`);
}

const ATTRS: [string, string][] = [
  ['a', 'href'], ['link', 'href'], ['script', 'src'], ['img', 'src'], ['source', 'src'],
  ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['track', 'src'], ['embed', 'src'],
  ['img', 'data-src'], ['image', 'href'], ['use', 'href'],
];

export interface RewriteResult { html: string; cleaned: string[] }

export function rewriteHtml(html: string, base: string, fromLocal: string, map: Resolver, clean: boolean): RewriteResult {
  const $ = cheerio.load(html);
  const cleaned = clean ? cleanDom($) : [];
  $('base').remove();
  for (const [tag, attr] of ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      $(el).attr(attr, ref($(el).attr(attr)!, base, fromLocal, map));
    });
  }
  $('[srcset]').each((_, el) => {
    const v = $(el).attr('srcset')!;
    $(el).attr(
      'srcset',
      v.split(',').map((part) => {
        const [u, ...d] = part.trim().split(/\s+/);
        return [ref(u ?? '', base, fromLocal, map), ...d].join(' ');
      }).join(', '),
    );
  });
  $('style').each((_, el) => {
    $(el).text(rewriteCss($(el).text(), base, fromLocal, map));
  });
  $('[style]').each((_, el) => {
    $(el).attr('style', rewriteCss($(el).attr('style')!, base, fromLocal, map));
  });
  // integrity hashes break once we rewrite/clean content
  $('[integrity]').removeAttr('integrity').removeAttr('crossorigin');
  return { html: $.html(), cleaned };
}
