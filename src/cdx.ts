/**
 * Wayback CDX inventory adapter.
 *
 * One archive client for the whole package. The query is declared explicitly
 * and recorded verbatim in evidence, because an exact-URL query is not a
 * domain inventory and a report that does not say which was issued cannot be
 * read (docs/SPEC.md section 5.1).
 *
 * The query shape is pinned: `output=json`, an explicit `fl=` field list,
 * `collapse=digest`, a declared limit and `showResumeKey` continuation. The
 * status filter is deliberately NOT sent upstream. `filter=statuscode:200`
 * would make the provider drop redirect and error rows, and those rows are the
 * evidence of when a page moved or died. The same expression is applied here
 * instead, so a non-200 row is excluded from acquisition candidates while
 * staying in the record (issue #7).
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

/* -------------------------------------------------------------------------- */
/* candidate filtering                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The acquisition-candidate rule, in CDX filter syntax.
 *
 * A capture the origin answered with a redirect or an error is not a page to
 * rebuild from. It is still evidence, so the rule excludes rather than deletes:
 * `partitionRows` returns both halves and the caller records both.
 *
 * The rule ranks captures within a URL; it does not decide which URLs exist.
 * A URL whose only captures are excluded is still acquired, from an excluded
 * capture, and said so in the report. Dropping it would delete the origin's
 * own error page, which is the single thing that establishes a site's error
 * template for soft-404 detection (src/classify.ts, issue #5).
 */
export const DEFAULT_CANDIDATE_FILTERS: readonly string[] = ['statuscode:200'];

export interface CdxFilter {
  field: string;
  /** Anchored regular expression source, as CDX filter expressions use. */
  pattern: string;
  negated: boolean;
  /** The expression verbatim, so the report names the rule that fired. */
  source: string;
}

const FILTER_FIELDS: Readonly<Record<string, keyof CdxRow>> = {
  urlkey: 'urlkey',
  timestamp: 'timestamp',
  original: 'original',
  mimetype: 'mimetype',
  statuscode: 'statusCode',
  digest: 'digest',
  length: 'length',
};

/** `[!]field:regex`, the CDX server's own filter form. */
export function parseCdxFilter(expression: string): CdxFilter {
  const negated = expression.startsWith('!');
  const body = negated ? expression.slice(1) : expression;
  const separator = body.indexOf(':');
  if (separator <= 0) throw new Error(`CDX filter ${expression} is not field:pattern`);
  const field = body.slice(0, separator).toLowerCase();
  if (!(field in FILTER_FIELDS)) throw new Error(`CDX filter ${expression} names an unselected field`);
  return { field, pattern: body.slice(separator + 1), negated, source: expression };
}

export function rowMatchesFilter(row: CdxRow, filter: CdxFilter): boolean {
  const key = FILTER_FIELDS[filter.field];
  if (key === undefined) return true;
  const matched = new RegExp(`^(?:${filter.pattern})$`, 'u').test(row[key]);
  return filter.negated ? !matched : matched;
}

/** The filter expression a row failed, or null when it passed them all. */
export function rowExclusion(row: CdxRow, filters: readonly CdxFilter[]): string | null {
  return filters.find((filter) => !rowMatchesFilter(row, filter))?.source ?? null;
}

export interface ExcludedRow {
  row: CdxRow;
  /** The filter expression this row failed, verbatim. */
  excludedBy: string;
}

export interface RowPartition {
  /** Rows eligible to be fetched. */
  candidates: CdxRow[];
  /** Rows retained as timeline evidence and never fetched. */
  excluded: ExcludedRow[];
}

export function partitionRows(rows: readonly CdxRow[], expressions: readonly string[]): RowPartition {
  const filters = expressions.map(parseCdxFilter);
  const candidates: CdxRow[] = [];
  const excluded: ExcludedRow[] = [];

  for (const row of rows) {
    const excludedBy = rowExclusion(row, filters);
    if (excludedBy === null) candidates.push(row);
    else excluded.push({ row, excludedBy });
  }

  return { candidates, excluded };
}
