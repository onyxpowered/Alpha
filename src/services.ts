/**
 * Backend/hosting service detection. Evidence comes from:
 *  - live traffic and blocked attempts (so unallowlisted Firebase calls are still detected),
 *  - response-header fingerprints,
 *  - URLs and config referenced inside captured scripts/HTML (even if never called during play),
 *  - SDK globals found in the page.
 * To add a service, append a rule to URL_RULES / HEADER_RULES.
 */

export interface DetectedService {
  service: string;
  roles: string[];
  projects: string[];
  evidence: string[];
  live: boolean; // seen in actual traffic/headers (vs only referenced in code)
  blocked: boolean; // some of its traffic was blocked by the allowlist
  origins: string[]; // https origins to allowlist to capture its traffic (via `zero allow --asset`)
}

interface UrlRule {
  service: string;
  role: string;
  host: RegExp;
  path?: RegExp;
  project?: (u: URL) => string | undefined;
}
interface HeaderRule { service: string; role: string; header: string; value?: RegExp }

const first = (u: URL) => u.hostname.split('.')[0];
const fromPath = (re: RegExp) => (u: URL) => re.exec(decodeURIComponent(u.pathname + u.search))?.[1];

export const URL_RULES: UrlRule[] = [
  // ---- Firebase
  { service: 'Firebase', role: 'Realtime Database', host: /\.(firebaseio\.com|firebasedatabase\.app)$/i, project: (u) => u.searchParams.get('ns') ?? (/^s-/.test(first(u)!) ? undefined : first(u)) },
  { service: 'Firebase', role: 'Firestore', host: /^firestore\.googleapis\.com$/i, project: fromPath(/projects\/([a-z0-9-]+)/i) },
  { service: 'Firebase', role: 'Auth', host: /^(identitytoolkit|securetoken)\.googleapis\.com$/i },
  { service: 'Firebase', role: 'Storage', host: /^firebasestorage\.googleapis\.com$/i, project: fromPath(/\/b\/([a-z0-9-]+)/i) },
  { service: 'Firebase', role: 'Cloud Functions', host: /\.cloudfunctions\.net$/i, project: (u) => /^[a-z]+-[a-z]+\d+-(.+)\.cloudfunctions\.net$/i.exec(u.hostname)?.[1] },
  { service: 'Firebase', role: 'Cloud Run', host: /\.run\.app$/i },
  { service: 'Firebase', role: 'Hosting', host: /\.(web\.app|firebaseapp\.com)$/i, project: first },
  { service: 'Firebase', role: 'Messaging/Installations/Remote Config', host: /^(fcm|firebaseinstallations|firebaseremoteconfig)\.googleapis\.com$/i },
  { service: 'Firebase', role: 'SDK (CDN)', host: /^www\.gstatic\.com$/i, path: /\/firebasejs\//i },
  // ---- Netlify
  { service: 'Netlify', role: 'Hosting', host: /\.netlify\.app$/i, project: first },
  { service: 'Netlify', role: 'Functions', host: /.*/, path: /\/\.netlify\/functions\/[\w.-]+/i },
  { service: 'Netlify', role: 'Edge Functions', host: /.*/, path: /\/\.netlify\/edge-functions\//i },
  { service: 'Netlify', role: 'Identity', host: /.*/, path: /\/\.netlify\/identity/i },
  { service: 'Netlify', role: 'Large Media', host: /.*/, path: /\/\.netlify\/large-media/i },
  // ---- others a game dev is likely to hit
  { service: 'Supabase', role: 'Backend', host: /\.supabase\.(co|in)$/i, project: first },
  { service: 'Vercel', role: 'Hosting', host: /\.vercel\.app$/i, project: first },
  { service: 'Cloudflare', role: 'Pages/Workers', host: /\.(pages|workers)\.dev$/i, project: first },
  { service: 'PlayFab', role: 'Backend', host: /\.playfabapi\.com$/i, project: first },
  { service: 'Photon', role: 'Realtime/PUN', host: /\.(photonengine\.(io|com)|exitgames\.com)$/i },
  { service: 'AWS', role: 'S3/CloudFront/API', host: /\.(amazonaws\.com|cloudfront\.net)$/i },
  { service: 'GitHub Pages', role: 'Hosting', host: /\.github\.io$/i, project: first },
  { service: 'itch.io', role: 'Hosting', host: /\.(itch\.zone|itch\.io)$/i },
];

export const HEADER_RULES: HeaderRule[] = [
  { service: 'Netlify', role: 'Hosting (header)', header: 'x-nf-request-id' },
  { service: 'Netlify', role: 'Hosting (header)', header: 'server', value: /netlify/i },
  { service: 'Vercel', role: 'Hosting (header)', header: 'x-vercel-id' },
  { service: 'Cloudflare', role: 'CDN (header)', header: 'cf-ray' },
  { service: 'AWS', role: 'CloudFront (header)', header: 'x-amz-cf-id' },
  { service: 'AWS', role: 'S3 (header)', header: 'x-amz-request-id' },
  { service: 'GitHub Pages', role: 'Hosting (header)', header: 'x-github-request-id' },
  { service: 'Firebase', role: 'Hosting (header)', header: 'x-served-by', value: /^cache-/i },
];

export interface ServiceInput {
  traffic: string[]; // URLs observed in live traffic (pages, assets, fetch/XHR, sockets)
  blocked: string[]; // URLs the game tried to reach that the allowlist refused
  headers: Record<string, string>;
  texts: string[]; // captured script/HTML/JSON text bodies
  globals: string[]; // from the runtime probe, e.g. 'Firebase'
}

const URL_IN_TEXT = /(?:https?|wss?):\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?/gi;
const PROJECT_ID_IN_TEXT = /projectId["']?\s*[:=]\s*["']([a-z0-9-]{4,40})["']/gi;

export function detectServices(input: ServiceInput): DetectedService[] {
  const found = new Map<string, DetectedService>();
  const get = (service: string): DetectedService => {
    let s = found.get(service);
    if (!s) found.set(service, (s = { service, roles: [], projects: [], evidence: [], live: false, blocked: false, origins: [] }));
    return s;
  };
  const add = (s: DetectedService, role: string, ev: string, live: boolean, blocked = false, project?: string, origin?: string) => {
    if (!s.roles.includes(role)) s.roles.push(role);
    if (project && !s.projects.includes(project)) s.projects.push(project);
    if (s.evidence.length < 6 && !s.evidence.includes(ev)) s.evidence.push(ev);
    if (origin && !s.origins.includes(origin)) s.origins.push(origin);
    s.live ||= live;
    s.blocked ||= blocked;
  };

  const scanUrl = (raw: string, live: boolean, blocked: boolean, how: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return;
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return;
    for (const r of URL_RULES) {
      if (!r.host.test(u.hostname)) continue;
      if (r.path && !r.path.test(u.pathname)) continue;
      const origin = `https://${u.host}`;
      add(get(r.service), r.role, `${how}: ${u.host}${u.pathname.slice(0, 60)}`, live, blocked, r.project?.(u), origin);
    }
  };

  for (const u of input.traffic) scanUrl(u, true, false, 'traffic');
  for (const u of input.blocked) scanUrl(u, true, true, 'blocked');
  for (const [name, value] of Object.entries(input.headers)) {
    for (const r of HEADER_RULES) {
      if (r.header === name && (!r.value || r.value.test(value))) add(get(r.service), r.role, `header ${name}: ${value.slice(0, 40)}`, true);
    }
  }
  for (const g of input.globals) add(get(g), 'SDK global in page', `window global (${g})`, true);

  for (const text of input.texts) {
    for (const m of (text.match(URL_IN_TEXT) ?? []).slice(0, 2000)) scanUrl(m, false, false, 'in code');
    if (!/firebase/i.test(text)) continue; // projectId alone is too generic
    for (const m of text.matchAll(PROJECT_ID_IN_TEXT)) add(get('Firebase'), 'SDK config in code', `firebase projectId in code: ${m[1]}`, false, false, m[1]);
  }

  return [...found.values()];
}
