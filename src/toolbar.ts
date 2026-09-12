/**
 * Defensive removal of archive-injected markup.
 *
 * A replay fetched with the identity modifier returns the captured bytes and
 * nothing else, so on a correct fetch this module removes nothing. That is the
 * point: it is insurance against a provider that rewrites anyway, and the
 * fixtures prove it is not doing load-bearing work (issue #7).
 *
 * The rule list is short and literal on purpose. Every rule matches the
 * provider's own injected nodes, never an inference from page prose, so a
 * captured page that merely talks about the Wayback Machine is left alone.
 *
 * Markup is untrusted data. Nothing here is parsed into a live DOM, executed,
 * or treated as an instruction (agentic/contract.json,
 * safety.archived_content_is_data).
 */

/**
 * Substrings that betray injected replay markup. They are what the fixtures
 * assert are absent from identity-fetched bytes, and what a residual check
 * looks for after stripping.
 */
export const ARCHIVE_INJECTION_MARKERS: readonly string[] = [
  'wm-ipp',
  '/_static/',
  'WAYBACK TOOLBAR INSERT',
  '__wm.',
  'archive_analytics',
  'FILE ARCHIVED ON',
];

/** Caps the work one hostile or generated body can create. */
const MAX_REMOVALS = 64;

export interface InjectionRemoval {
  /** Which rule fired, so the evidence report names a cause, not a guess. */
  rule: string;
  /** Characters removed. Body text itself never reaches the report. */
  characters: number;
}

export interface StripResult {
  text: string;
  removals: InjectionRemoval[];
  /** Markers still present after stripping, so partial cleaning is visible. */
  residual: string[];
}

interface DelimitedRule {
  kind: 'delimited';
  name: string;
  open: string;
  close: string;
}

interface TagRule {
  kind: 'tag';
  name: string;
  /** Matches one self-contained tag, or an element with its closing tag. */
  pattern: RegExp;
  /** The match is dropped only when it also contains this substring. */
  requires: string;
}

interface ElementRule {
  kind: 'element';
  name: string;
  tag: string;
  /** Matches the opening tag's attributes. */
  opening: RegExp;
}

type InjectionRule = DelimitedRule | TagRule | ElementRule;

/**
 * Order matters: the toolbar comment pair wraps the toolbar element, so
 * removing the pair first leaves the element rules with nothing to do.
 */
const RULES: readonly InjectionRule[] = [
  {
    kind: 'delimited',
    name: 'wayback-toolbar-insert',
    open: '<!-- BEGIN WAYBACK TOOLBAR INSERT -->',
    close: '<!-- END WAYBACK TOOLBAR INSERT -->',
  },
  {
    kind: 'tag',
    name: 'file-archived-comment',
    pattern: /<!--[\s\S]*?-->/gu,
    requires: 'FILE ARCHIVED ON',
  },
  {
    kind: 'element',
    name: 'wayback-toolbar-element',
    tag: 'div',
    opening: /<div\b[^>]*\bid\s*=\s*["']?wm-ipp[\w-]*["']?[^>]*>/iu,
  },
  {
    kind: 'tag',
    name: 'replay-static-script',
    pattern: /<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/giu,
    requires: '/_static/',
  },
  {
    kind: 'tag',
    name: 'replay-static-stylesheet',
    pattern: /<link\b[^>]*>/giu,
    requires: '/_static/',
  },
  {
    kind: 'tag',
    name: 'replay-analytics-script',
    pattern: /<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/giu,
    requires: 'archive.org/includes/',
  },
  {
    kind: 'tag',
    name: 'replay-init-script',
    pattern: /<script\b[^>]*>[\s\S]*?<\/script>/giu,
    requires: '__wm.',
  },
  {
    kind: 'tag',
    name: 'replay-analytics-inline-script',
    pattern: /<script\b[^>]*>[\s\S]*?<\/script>/giu,
    requires: 'archive_analytics',
  },
];

export function stripArchiveInjection(text: string): StripResult {
  let current = text;
  const removals: InjectionRemoval[] = [];

  for (const rule of RULES) {
    if (removals.length >= MAX_REMOVALS) break;
    const applied = applyRule(current, rule);
    current = applied.text;
    removals.push(...applied.removals);
  }

  const residual = ARCHIVE_INJECTION_MARKERS.filter((marker) => current.includes(marker));
  return { text: current, removals, residual };
}

/** True when the bytes carry any marker of injected replay markup. */
export function hasArchiveInjection(text: string): boolean {
  return ARCHIVE_INJECTION_MARKERS.some((marker) => text.includes(marker));
}

function applyRule(text: string, rule: InjectionRule): { text: string; removals: InjectionRemoval[] } {
  if (rule.kind === 'delimited') return applyDelimited(text, rule);
  if (rule.kind === 'tag') return applyTag(text, rule);
  return applyElement(text, rule);
}

function applyDelimited(text: string, rule: DelimitedRule): { text: string; removals: InjectionRemoval[] } {
  const removals: InjectionRemoval[] = [];
  let current = text;

  for (let guard = 0; guard < MAX_REMOVALS; guard += 1) {
    const start = current.indexOf(rule.open);
    if (start === -1) break;
    const closeAt = current.indexOf(rule.close, start + rule.open.length);
    // An unterminated opener is left in place: removing to end of document
    // would destroy captured content on the strength of one marker.
    if (closeAt === -1) break;
    const end = closeAt + rule.close.length;
    removals.push({ rule: rule.name, characters: end - start });
    current = current.slice(0, start) + current.slice(end);
  }

  return { text: current, removals };
}

function applyTag(text: string, rule: TagRule): { text: string; removals: InjectionRemoval[] } {
  const removals: InjectionRemoval[] = [];
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
  const kept: string[] = [];
  let cursor = 0;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (!match[0].includes(rule.requires)) continue;
    if (removals.length >= MAX_REMOVALS) break;
    kept.push(text.slice(cursor, match.index));
    removals.push({ rule: rule.name, characters: match[0].length });
    cursor = match.index + match[0].length;
  }
  kept.push(text.slice(cursor));

  return { text: removals.length === 0 ? text : kept.join(''), removals };
}

/**
 * Removes an element and its descendants by counting nested openings, so a
 * toolbar that contains inner divs does not leave its tail behind.
 */
function applyElement(text: string, rule: ElementRule): { text: string; removals: InjectionRemoval[] } {
  const removals: InjectionRemoval[] = [];
  let current = text;
  const open = new RegExp(`<${rule.tag}\\b`, 'giu');
  const close = new RegExp(`</${rule.tag}\\s*>`, 'giu');

  for (let guard = 0; guard < MAX_REMOVALS; guard += 1) {
    const opener = new RegExp(rule.opening.source, rule.opening.flags.replace('g', '')).exec(current);
    if (opener === null) break;

    const start = opener.index;
    let cursor = start + opener[0].length;
    let depth = 1;
    let end = -1;

    while (depth > 0) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const nextOpen = open.exec(current);
      const nextClose = close.exec(current);
      if (nextClose === null) break;
      if (nextOpen !== null && nextOpen.index < nextClose.index) {
        depth += 1;
        cursor = nextOpen.index + nextOpen[0].length;
        continue;
      }
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) end = cursor;
    }

    // An unclosed injected element is left in place and shows up as a residual
    // marker rather than taking the rest of the document with it.
    if (end === -1) break;
    removals.push({ rule: rule.name, characters: end - start });
    current = current.slice(0, start) + current.slice(end);
  }

  return { text: current, removals };
}
