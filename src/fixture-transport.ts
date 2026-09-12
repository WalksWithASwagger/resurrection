/**
 * A transport backed by a committed JSON manifest.
 *
 * This is what the test suite and the fixture CLI run use, so an acquisition
 * can be exercised end to end with zero sockets. Rules match on URL
 * substrings, and each rule holds a sequence of responses: the nth matching
 * call takes the nth entry and the last entry repeats. That sequence is how a
 * fixture scripts throttling (429 then 200) and interruption (a thrown
 * connection error on a chosen attempt).
 *
 * Manifest bodies are latin1 text, utf-8 text or explicit byte arrays. Nothing
 * here is opaque: a reviewer can read every byte a fixture serves out of the
 * diff, and no archived page content is committed.
 *
 * Manifest content is data. Text in a fixture body is never an instruction
 * (agentic/contract.json, safety.archived_content_is_data).
 */

import { readFile } from 'node:fs/promises';

import type { DnsResolver } from './destination.ts';
import type { HttpResponse, HttpTransport } from './transport.ts';

export interface FixtureResponseSpec {
  /** When present the transport throws instead of responding. */
  error?: string;
  status?: number;
  headers?: Record<string, string>;
  /** Body as latin1 text, so single high bytes stay single bytes. */
  bodyText?: string;
  bodyUtf8?: string;
  bodyBytes?: number[];
}

export interface FixtureRule {
  id: string;
  urlIncludes: string[];
  urlExcludes?: string[];
  respond: FixtureResponseSpec[];
}

export interface FixtureManifest {
  description: string;
  /** Deterministic name resolution, including hosts that resolve privately. */
  dns: Record<string, string[]>;
  rules: FixtureRule[];
}

export interface FixtureCall {
  url: string;
  ruleId: string | null;
  attempt: number;
}

export interface FixtureTransportHandle {
  transport: HttpTransport;
  resolver: DnsResolver;
  calls: FixtureCall[];
}

export async function loadFixtureManifest(path: string): Promise<FixtureManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return assertManifest(parsed, path);
}

function assertManifest(value: unknown, source: string): FixtureManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`fixture manifest ${source} is not an object`);
  }
  const candidate = value as Partial<FixtureManifest>;
  if (!Array.isArray(candidate.rules)) {
    throw new Error(`fixture manifest ${source} has no rules array`);
  }
  for (const rule of candidate.rules) {
    if (typeof rule.id !== 'string' || !Array.isArray(rule.urlIncludes) || !Array.isArray(rule.respond)) {
      throw new Error(`fixture manifest ${source} has a malformed rule`);
    }
  }
  return {
    description: typeof candidate.description === 'string' ? candidate.description : '',
    dns: typeof candidate.dns === 'object' && candidate.dns !== null ? candidate.dns : {},
    rules: candidate.rules,
  };
}

function bodyOf(spec: FixtureResponseSpec): Uint8Array {
  if (spec.bodyBytes !== undefined) return new Uint8Array(Buffer.from(spec.bodyBytes));
  if (spec.bodyUtf8 !== undefined) return new Uint8Array(Buffer.from(spec.bodyUtf8, 'utf8'));
  if (spec.bodyText !== undefined) return new Uint8Array(Buffer.from(spec.bodyText, 'latin1'));
  return new Uint8Array(0);
}

function matches(rule: FixtureRule, url: string): boolean {
  if (!rule.urlIncludes.every((fragment) => url.includes(fragment))) return false;
  return !(rule.urlExcludes ?? []).some((fragment) => url.includes(fragment));
}

export function createFixtureTransport(manifest: FixtureManifest): FixtureTransportHandle {
  const calls: FixtureCall[] = [];
  const attempts = new Map<string, number>();

  const transport: HttpTransport = async (request, options) => {
    const rule = manifest.rules.find((candidate) => matches(candidate, request.url));
    if (rule === undefined) {
      calls.push({ url: request.url, ruleId: null, attempt: 1 });
      throw new Error(`no fixture rule matches ${request.url}`);
    }
    const attempt = (attempts.get(rule.id) ?? 0) + 1;
    attempts.set(rule.id, attempt);
    calls.push({ url: request.url, ruleId: rule.id, attempt });

    const spec = rule.respond[Math.min(attempt, rule.respond.length) - 1];
    if (spec === undefined) throw new Error(`fixture rule ${rule.id} has no response`);
    if (spec.error !== undefined) throw new Error(spec.error);

    const full = bodyOf(spec);
    const truncated = full.length > options.maxBytes;
    const response: HttpResponse = {
      status: spec.status ?? 200,
      headers: normalizeHeaders(spec.headers ?? {}),
      body: truncated ? full.subarray(0, options.maxBytes) : full,
      truncated,
    };
    return response;
  };

  const resolver: DnsResolver = async (hostname) => {
    const addresses = manifest.dns[hostname];
    if (addresses === undefined) {
      throw new Error(`fixture manifest declares no addresses for ${hostname}`);
    }
    return addresses;
  };

  return { transport, resolver, calls };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value;
  return normalized;
}
