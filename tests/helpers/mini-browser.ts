/**
 * A deterministic stand-in for a browser, for tests of logic that sits around
 * a render. It reads the page through the responder it is given, like the
 * real renderer, and derives a title, text, anchors and requests from the
 * markup. Its "pixels" are one flat colour: white, or red when the page
 * carries `data-paint="red"`. Its geometry is document order, shifted by a
 * `data-shift` attribute. That is enough to make a page pass or fail each
 * check on purpose; it says nothing about real layout.
 */

import { encodePng, visibleText, type Anchor, type ReferenceRenderer, type RequestRecord } from '../../src/index.ts';

const ANCHOR_TAGS = /<(img|h[1-6]|a|form|hr)\b([^>]*)>(?:([^<]*)<\/a>)?/gi;

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes)?.[1] ?? null;
}

export function miniBrowser(browserVersion = '1'): ReferenceRenderer {
  return {
    async conditions(viewport) {
      return {
        browser: 'mini', browserVersion, platform: 'test', viewport, deviceScaleFactor: 1, locale: 'en-US',
        timezone: 'UTC', colorScheme: 'light', javaScriptEnabled: false, fullPage: true,
      };
    },
    async render(request) {
      const answer = await request.respond(request.url);
      if (answer.disposition !== 'served') throw new Error(`mini browser could not load ${request.url}`);
      const html = Buffer.from(answer.body).toString('utf8');
      const requests: RequestRecord[] = [{ url: request.url, disposition: 'served', sha256: answer.sha256 }];
      const anchors: Anchor[] = [];
      const ordinals = new Map<string, number>();
      let index = 0;
      for (const match of html.matchAll(ANCHOR_TAGS)) {
        const tag = (match[1] as string).toLowerCase();
        const attributes = match[2] ?? '';
        const ordinal = ordinals.get(tag) ?? 0;
        ordinals.set(tag, ordinal + 1);
        const href = tag === 'a' ? attribute(attributes, 'href') : null;
        const src = tag === 'img' ? attribute(attributes, 'src') : null;
        if (src !== null) {
          const url = new URL(src, request.url).toString();
          const resource = await request.respond(url);
          requests.push({ url, disposition: resource.disposition, sha256: resource.disposition === 'served' ? resource.sha256 : null });
        }
        anchors.push({
          tag,
          ordinal,
          rect: { x: 0, y: index * 20 + Number(attribute(attributes, 'data-shift') ?? 0), width: 100, height: 20 },
          label: src ?? (match[3] ?? '').trim(),
          target: href === null ? null : new URL(href, request.url).toString(),
        });
        index += 1;
      }
      const red = html.includes('data-paint="red"');
      const data = new Uint8Array(20 * 20 * 4);
      for (let pixel = 0; pixel < 400; pixel += 1) data.set(red ? [255, 0, 0, 255] : [255, 255, 255, 255], pixel * 4);
      return {
        screenshot: encodePng({ width: 20, height: 20, data }),
        screenshotStable: true,
        documentSize: { width: 20, height: 20 },
        title: /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '',
        text: visibleText(html),
        anchors,
        requests,
        pageErrors: [],
      };
    },
    async close() {},
  };
}
