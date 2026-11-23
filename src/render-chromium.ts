/**
 * The Chromium reference renderer.
 *
 * Every request a page makes is intercepted and answered by the responder it
 * was given, so a render opens no socket: a site URL is served from stored
 * bytes or aborted as missing, and everything else is aborted as external.
 * Page scripts are disabled and service workers are blocked, because archived
 * code is untrusted (docs/SPEC.md section 10).
 *
 * `playwright-core` is imported lazily so that acquisition, modeling and the
 * bundle logic never need a browser installed.
 */

import type { Anchor, ReferenceRenderer, RenderConditions, RenderRequest, RenderResult, RequestRecord } from './reference.ts';

const LOCALE = 'en-US';
const TIMEZONE = 'UTC';
const NAVIGATION_TIMEOUT_MS = 30_000;

interface Measurement {
  anchors: Anchor[];
  documentSize: { width: number; height: number };
  text: string;
}

/**
 * Evaluated inside the page as a string, so this package needs no DOM types.
 * Measures the elements a layout comparison anchors on, in document
 * coordinates. These are things a visitor sees or uses. Layout containers
 * such as tables are left out on purpose: a rebuilt page may lay the same
 * content out with different containers, and their effect is already held by
 * the positions of the content inside them and by the pixels.
 */
const MEASURE_SCRIPT = `(() => {
  const limit = 5000;
  const tags = ['img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'form', 'hr', 'iframe', 'frame'];
  const anchors = [];
  for (const tag of tags) {
    const elements = Array.from(document.getElementsByTagName(tag));
    for (let ordinal = 0; ordinal < elements.length && anchors.length < limit; ordinal += 1) {
      const element = elements[ordinal];
      const box = element.getBoundingClientRect();
      const label = tag === 'img'
        ? (element.getAttribute('src') || '')
        : (tag === 'a' || /^h[1-6]$/.test(tag)) ? (element.innerText || '') : '';
      anchors.push({
        tag,
        ordinal,
        rect: { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height },
        label: label.replace(/\\s+/g, ' ').trim().slice(0, 120),
        target: tag === 'a' && element.getAttribute('href') !== null ? element.href : null,
      });
    }
  }
  const root = document.documentElement;
  return {
    anchors,
    documentSize: { width: root.scrollWidth, height: root.scrollHeight },
    text: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim(),
  };
})()`;

export async function createChromiumRenderer(): Promise<ReferenceRenderer> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();

  return {
    async conditions(viewport): Promise<RenderConditions> {
      return {
        browser: 'chromium',
        browserVersion: browser.version(),
        platform: `${process.platform}-${process.arch}`,
        viewport: { ...viewport },
        deviceScaleFactor: 1,
        locale: LOCALE,
        timezone: TIMEZONE,
        colorScheme: 'light',
        javaScriptEnabled: false,
        fullPage: true,
      };
    },

    async render(request: RenderRequest): Promise<RenderResult> {
      const context = await browser.newContext({
        viewport: { ...request.viewport },
        deviceScaleFactor: 1,
        locale: LOCALE,
        timezoneId: TIMEZONE,
        colorScheme: 'light',
        reducedMotion: 'reduce',
        javaScriptEnabled: request.javaScriptEnabled,
        serviceWorkers: 'block',
      });
      try {
        const requests: RequestRecord[] = [];
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          const answer = await request.respond(url);
          if (answer.disposition === 'served') {
            requests.push({ url, disposition: 'served', sha256: answer.sha256 });
            await route.fulfill({
              status: 200,
              body: Buffer.from(answer.body),
              ...(answer.contentType === null ? {} : { contentType: answer.contentType }),
            });
          } else {
            requests.push({ url, disposition: answer.disposition, sha256: null });
            await route.abort('failed');
          }
        });

        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
        await page.goto(request.url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
        const options = { fullPage: true, animations: 'disabled', caret: 'hide' } as const;
        const first = await page.screenshot(options);
        const second = await page.screenshot(options);
        const measured = (await page.evaluate(MEASURE_SCRIPT)) as Measurement;
        return {
          screenshot: new Uint8Array(first),
          screenshotStable: first.equals(second),
          documentSize: measured.documentSize,
          title: await page.title(),
          text: measured.text,
          anchors: measured.anchors,
          requests,
          pageErrors,
        };
      } finally {
        await context.close();
      }
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
