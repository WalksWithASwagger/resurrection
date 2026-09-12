/**
 * Connection-level destination control.
 *
 * Archived pages are untrusted input, and so is every redirect an archive
 * replay emits. This module decides whether a URL may be connected to at all:
 * scheme, credentials, port, provider allowlist, then the resolved addresses.
 * It runs before the first request and again on every redirect target, because
 * a redirect is the cheapest way for archived content to aim a fetch at a
 * private address (docs/SPEC.md section 10).
 *
 * Name resolution is injected so a fixture run is deterministic and so the
 * guard itself is testable without a network.
 */

import { isIP } from 'node:net';

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface DestinationPolicy {
  /**
   * Hosts that may be connected to, matched exactly or as a parent domain.
   * An empty list allows any public host; the pilot configuration sets the
   * archive provider so the live origin of a dead domain is never fetched.
   */
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
}

export type DestinationDecision =
  | { allowed: true; hostname: string; addresses: readonly string[] }
  | { allowed: false; reason: string };

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/** Resolver used by the live transport. Kept out of the pure guard logic. */
export async function systemResolver(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  const entries = await lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

function hostMatches(hostname: string, allowed: string): boolean {
  const host = hostname.toLowerCase();
  const pattern = allowed.toLowerCase();
  return host === pattern || host.endsWith(`.${pattern}`);
}

function ipv4Parts(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    numbers.push(value);
  }
  return numbers;
}

/** Ranges that must never be connected to, with the reason recorded verbatim. */
function blockedIpv4Reason(address: string): string | null {
  const parts = ipv4Parts(address);
  if (parts === null) return 'unparseable IPv4 address';
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0) return 'unspecified 0.0.0.0/8';
  if (a === 10) return 'private 10.0.0.0/8';
  if (a === 127) return 'loopback 127.0.0.0/8';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT 100.64.0.0/10';
  if (a === 169 && b === 254) return 'link-local 169.254.0.0/16 (includes cloud metadata)';
  if (a === 172 && b >= 16 && b <= 31) return 'private 172.16.0.0/12';
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments 192.0.0.0/24';
  if (a === 192 && b === 168) return 'private 192.168.0.0/16';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking 198.18.0.0/15';
  if (a >= 224) return 'multicast or reserved 224.0.0.0/3';
  return null;
}

function blockedIpv6Reason(address: string): string | null {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::' ) return 'unspecified ::';
  if (normalized === '::1') return 'loopback ::1';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (mapped?.[1] !== undefined) {
    return blockedIpv4Reason(mapped[1]) ?? null;
  }
  // Node normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1, so the embedded IPv4
  // address has to be reassembled before it can be classified.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hexMapped !== null) {
    const high = Number.parseInt(hexMapped[1] as string, 16);
    const low = Number.parseInt(hexMapped[2] as string, 16);
    const embedded = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return blockedIpv4Reason(embedded) ?? null;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'unique local fc00::/7';
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'link-local fe80::/10';
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return 'multicast ff00::/8';
  if (normalized.startsWith('64:ff9b:')) return 'NAT64 64:ff9b::/96';
  return null;
}

/** Null when the literal address may be connected to. */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blockedIpv4Reason(address);
  if (family === 6) return blockedIpv6Reason(address);
  return 'not an IP address';
}

export async function checkDestination(
  rawUrl: string,
  policy: DestinationPolicy,
  resolve: DnsResolver,
): Promise<DestinationDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `unparseable URL ${rawUrl}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `scheme ${url.protocol} is not http or https` };
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'URL carries embedded credentials' };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    return { allowed: false, reason: `port ${port} is not in the allowed set` };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') return { allowed: false, reason: 'URL has no host' };

  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some((allowed) => hostMatches(hostname, allowed))) {
    return { allowed: false, reason: `host ${hostname} is not an allowed provider host` };
  }

  if (isIP(hostname) !== 0) {
    const blocked = blockedAddressReason(hostname);
    if (blocked !== null) {
      return { allowed: false, reason: `literal address ${hostname} is ${blocked}` };
    }
    return { allowed: true, hostname, addresses: [hostname] };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    return { allowed: false, reason: `cannot resolve ${hostname}: ${describe(error)}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `${hostname} resolved to no addresses` };
  }
  for (const address of addresses) {
    const blocked = blockedAddressReason(address);
    if (blocked !== null) {
      return { allowed: false, reason: `${hostname} resolves to ${address}, which is ${blocked}` };
    }
  }
  return { allowed: true, hostname, addresses };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
