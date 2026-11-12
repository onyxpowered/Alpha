import { chromium, type Browser, type BrowserContext } from 'playwright';

/** Fresh headless Chromium + throwaway context: no persisted profile, no downloads, no service workers. */
export async function launchDisposable(): Promise<{ browser: Browser; context: BrowserContext }> {
  // Test-only: lets two RTCPeerConnections in one page connect over loopback (mDNS candidate hiding blocks it). Off by default.
  const args = process.env.ZERO_TEST_RTC_LOOPBACK === '1' ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [];
  const browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    // Test-only escape hatch for a self-signed localhost fixture. Off by default.
    ignoreHTTPSErrors: process.env.ZERO_TEST_IGNORE_TLS === '1',
    viewport: { width: 1440, height: 900 },
  });
  return { browser, context };
}
