/**
 * Ciclo de vida do Chromium. Uma instancia so, reusada entre requests —
 * lancar o browser custa ~1s, entao vale manter de pe.
 */
import { chromium } from 'playwright';

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close().catch(() => {});
}
