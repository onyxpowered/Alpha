import type { CheerioAPI } from 'cheerio';

const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'doubleclick.net',
  'connect.facebook.net', 'facebook.com/tr', 'hotjar.com', 'segment.com', 'segment.io', 'mixpanel.com',
  'clarity.ms', 'fullstory.com', 'amplitude.com', 'heap.io', 'heapanalytics.com', 'plausible.io',
  'static.cloudflareinsights.com', 'bat.bing.com', 'snap.licdn.com', 'analytics.tiktok.com', 'sentry.io',
];
const INLINE_TRACKER = /\b(gtag\s*\(|fbq\s*\(|dataLayer\s*=|_gaq|GoogleAnalyticsObject|hj\s*\(|mixpanel\.|analytics\.(load|track)|clarity\s*\()/;

export const isTrackerUrl = (u: string): boolean => TRACKER_HOSTS.some((h) => u.includes(h));

/** Strip analytics/tracking only. Returns a log of what was removed. */
export function cleanDom($: CheerioAPI): string[] {
  const removed: string[] = [];
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (isTrackerUrl(src)) {
      removed.push(`script ${src}`);
      $(el).remove();
    }
  });
  $('script:not([src])').each((_, el) => {
    if (INLINE_TRACKER.test($(el).text())) {
      removed.push('inline tracker script');
      $(el).remove();
    }
  });
  $('img, iframe, link').each((_, el) => {
    const ref = $(el).attr('src') ?? $(el).attr('href') ?? '';
    if (ref && isTrackerUrl(ref)) {
      removed.push(`${el.tagName} ${ref}`);
      $(el).remove();
    }
  });
  $('noscript').each((_, el) => {
    if (isTrackerUrl($(el).html() ?? '')) {
      removed.push('noscript tracker');
      $(el).remove();
    }
  });
  return removed;
}
