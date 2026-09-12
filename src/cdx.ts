/**
 * Wayback CDX inventory adapter.
 *
 * One archive client for the whole package. The query is declared explicitly
 * and recorded verbatim in evidence, because an exact-URL query is not a
 * domain inventory and a report that does not say which was issued cannot be
 * read (docs/SPEC.md section 5.1).
 *
 * Scope here is deliberately narrow: build the query, parse the response,
 * carry the continuation key. Pinning the canonical query shape, the replay
 * modifier policy and capture selection is issue #7, which hardens this
 * adapter rather than forking a second one.
 */

export const DEFAULT_CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

export type MatchType = 'exact' | 'prefix' | 'host' | 'domain';

export interface CdxQuery {
  url: string;
  matchType: MatchType;
  /** Inclusive bounds as CDX timestamps (YYYYMMDDhhmmss, or a prefix). */
  from?: string | null;
  to?: string | null;
  limit: number;
  /** Adjacent-duplicate collapse. Not proof of unique-content coverage. */
  collapse?: string | null;
  filter?: readonly string[];
  resumeKey?: string | null;
}

export const CDX_FIELDS = [
  'urlkey',
  'timestamp',
  'original',
  'mimetype',
  'statuscode',
  'digest',
  'length',
] as const;

export interface CdxRow {
  urlkey: string;
  timestamp: string;
  original: string;
  mimetype: string;
  statusCode: string;
  digest: string;
  length: string;
}

export interface CdxPage {
  rows: CdxRow[];
  /** Present when the provider has more rows for this query. */
  resumeKey: string | null;
  /** The page filled the requested limit, so the inventory may be partial. */
  limitReached: boolean;
}

export function buildCdxUrl(endpoint: string, query: CdxQuery): string {
  const url = new URL(endpoint);
  const parameters = url.searchParams;
  parameters.set('url', query.url);
  parameters.set('matchType', query.matchType);
  parameters.set('output', 'json');
  parameters.set('fl', CDX_FIELDS.join(','));
  parameters.set('limit', String(query.limit));
  if (query.from != null && query.from !== '') parameters.set('from', query.from);
  if (query.to != null && query.to !== '') parameters.set('to', query.to);
  if (query.collapse != null && query.collapse !== '') parameters.set('collapse', query.collapse);
  for (const filter of query.filter ?? []) parameters.append('filter', filter);
  parameters.set('showResumeKey', 'true');
  if (query.resumeKey != null && query.resumeKey !== '') parameters.set('resumeKey', query.resumeKey);
  return url.toString();
}

/**
 * CDX JSON is a header row followed by value rows. With showResumeKey the tail
 * is a blank row and a single-cell row holding the key.
 */
export function parseCdxJson(text: string, limit: number): CdxPage {
  const trimmed = text.trim();
  if (trimmed === '') return { rows: [], resumeKey: null, limitReached: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`CDX response is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('CDX response is not an array');
  if (parsed.length === 0) return { rows: [], resumeKey: null, limitReached: false };

  const header = parsed[0];
  if (!Array.isArray(header)) throw new Error('CDX response has no header row');
  const columns = header.map((name) => String(name));

  const body = parsed.slice(1).filter((row): row is unknown[] => Array.isArray(row));
  let resumeKey: string | null = null;
  const dataRows: unknown[][] = [];
  for (let index = 0; index < body.length; index += 1) {
    const row = body[index] as unknown[];
    if (row.length === 0) {
      const next = body[index + 1];
      if (Array.isArray(next) && next.length === 1) resumeKey = String(next[0]);
      break;
    }
    dataRows.push(row);
  }

  const rows = dataRows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((name, index) => {
      record[name] = row[index] === undefined ? '' : String(row[index]);
    });
    return {
      urlkey: record['urlkey'] ?? '',
      timestamp: record['timestamp'] ?? '',
      original: record['original'] ?? '',
      mimetype: record['mimetype'] ?? '',
      statusCode: record['statuscode'] ?? '',
      digest: record['digest'] ?? '',
      length: record['length'] ?? '',
    };
  });

  return { rows, resumeKey, limitReached: rows.length >= limit };
}
