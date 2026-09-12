/**
 * Wayback replay URLs and capture times.
 *
 * The requested capture time and the time the provider actually served are
 * different facts and are recorded separately (docs/SPEC.md section 5.2). A
 * replay redirect that lands on a neighbouring capture is normal archive
 * behaviour, not an error, but a reconstruction that silently mixes eras is.
 */

export const DEFAULT_REPLAY_ENDPOINT = 'https://web.archive.org/web';

/**
 * `id_` asks for the captured bytes without the replay banner or rewritten
 * links. It is what every page, asset and document fetch uses, and
 * src/toolbar.ts proves byte for byte that the bytes carry no injected markup.
 */
export const IDENTITY_MODIFIER = 'id_';

/**
 * `if_` is the iframe variant: the provider serves the capture for embedding
 * without the replay banner. A frame is fetched with it rather than with `id_`
 * because that is the form the provider documents for framed replay, and it is
 * also the form most likely to carry rewriting, which is why the defensive
 * strip in src/toolbar.ts runs over every body and not only over frames.
 */
export const IFRAME_MODIFIER = 'if_';

export const REPLAY_MODIFIERS: readonly string[] = [IDENTITY_MODIFIER, IFRAME_MODIFIER];

/**
 * The modifier is a per-fetch decision, taken from the relation the link was
 * discovered through, and recorded on the item rather than assumed.
 */
export function replayModifierFor(relation: string): string {
  return relation === 'frame' ? IFRAME_MODIFIER : IDENTITY_MODIFIER;
}

export function buildReplayUrl(
  endpoint: string,
  timestamp: string,
  originalUrl: string,
  modifier: string = IDENTITY_MODIFIER,
): string {
  return `${endpoint.replace(/\/+$/, '')}/${timestamp}${modifier}/${originalUrl}`;
}

/**
 * A CDX timestamp may be a prefix. Expanding it to the first or last instant
 * it covers is what lets a declared period such as `1999` be compared against
 * a full capture time without pretending the prefix was a precise moment.
 */
export function expandTimestamp(value: string, edge: 'start' | 'end'): string {
  if (!/^\d{4,14}$/.test(value)) return value;
  if (value.length === 14) return value;

  const year = Number(value.slice(0, 4));
  const month = value.length >= 6 ? Number(value.slice(4, 6)) : edge === 'start' ? 1 : 12;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = value.length >= 8 ? Number(value.slice(6, 8)) : edge === 'start' ? 1 : lastDay;
  const hour = value.length >= 10 ? Number(value.slice(8, 10)) : edge === 'start' ? 0 : 23;
  const minute = value.length >= 12 ? Number(value.slice(10, 12)) : edge === 'start' ? 0 : 59;
  const second = edge === 'start' ? 0 : 59;

  return (
    String(year).padStart(4, '0') +
    pad(month) +
    pad(day) +
    pad(hour) +
    pad(minute) +
    pad(second)
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export interface ReplayParts {
  timestamp: string;
  modifier: string;
  originalUrl: string;
}

const REPLAY_PATTERN = /\/web\/(\d{4,14})([a-z_]*)\/(.+)$/i;

export function parseReplayUrl(url: string): ReplayParts | null {
  const match = REPLAY_PATTERN.exec(url);
  if (match === null) return null;
  return {
    timestamp: match[1] as string,
    modifier: match[2] ?? '',
    originalUrl: match[3] as string,
  };
}

/** CDX timestamp to epoch milliseconds. Null when it is not a full timestamp. */
export function timestampToEpochMs(timestamp: string): number | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(
    8,
    10,
  )}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

export function timestampToIso(timestamp: string): string | null {
  const epoch = timestampToEpochMs(timestamp);
  return epoch === null ? null : new Date(epoch).toISOString();
}

/** Absolute distance in seconds, or null when either side is unusable. */
export function captureDistanceSeconds(requested: string, served: string): number | null {
  const a = timestampToEpochMs(requested);
  const b = timestampToEpochMs(served);
  if (a === null || b === null) return null;
  return Math.round(Math.abs(a - b) / 1000);
}

/**
 * The capture time the provider actually served: the Memento-Datetime header
 * when present, otherwise the timestamp in the URL that finally answered.
 */
export function servedTimestamp(headers: Readonly<Record<string, string>>, finalUrl: string): string | null {
  const memento = headers['memento-datetime'];
  if (memento !== undefined) {
    const parsed = Date.parse(memento);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    }
  }
  return parseReplayUrl(finalUrl)?.timestamp ?? null;
}

/**
 * Markers of a provider error document served with status 200.
 *
 * The list is short and literal on purpose: these are the provider's own
 * markers, not an inference from page prose. It is the single source for
 * interstitial detection, used both by validation here and by the content
 * classifier in src/classify.ts, so there is one list to keep honest.
 */
const ARCHIVE_ERROR_MARKERS: readonly string[] = [
  'Wayback Machine has not archived that URL',
  'Got an HTTP 30',
  'This content is not available in the Wayback Machine',
  'The Wayback Machine has not archived that URL',
  'Hrm.',
  'job failed',
];

export function archiveErrorMarker(text: string): string | null {
  // Bounded: a provider error page is small, so only the head is inspected and
  // a long genuine capture cannot be scanned into a false positive.
  const head = text.slice(0, 4096);
  return ARCHIVE_ERROR_MARKERS.find((marker) => head.includes(marker)) ?? null;
}
