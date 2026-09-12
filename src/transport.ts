/**
 * The HTTP boundary.
 *
 * Everything above this module is deterministic and testable without a
 * network. The only implementation here that can open a socket is
 * `createLiveTransport`, and nothing in the test suite constructs it.
 *
 * The live transport uses `node:http`/`node:https` rather than `fetch` for one
 * reason: it can pin the connection to the addresses the destination guard
 * already approved, via the `lookup` hook. Resolving a name in the guard and
 * letting the client resolve it again leaves a window in which the second
 * answer differs from the first.
 */

export interface HttpRequest {
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  /** The body hit the byte cap and was cut short. */
  truncated: boolean;
}

export interface TransportOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Addresses the destination guard approved for this exact hostname. */
  pinnedAddresses?: readonly string[];
}

export type HttpTransport = (request: HttpRequest, options: TransportOptions) => Promise<HttpResponse>;

export const DEFAULT_USER_AGENT =
  'resurrection/0.0.0 (archive recovery; +https://github.com/WalksWithASwagger/resurrection)';

export function createLiveTransport(): HttpTransport {
  return async (request, options) => {
    const url = new URL(request.url);
    const client = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
    const pinned = options.pinnedAddresses ?? [];

    return await new Promise<HttpResponse>((resolve, reject) => {
      const outgoing = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { 'user-agent': DEFAULT_USER_AGENT, ...request.headers },
          timeout: options.timeoutMs,
          // Hands the socket the address the guard already cleared.
          lookup:
            pinned.length === 0
              ? undefined
              : (_hostname, _lookupOptions, callback) => {
                  const address = pinned[0] as string;
                  callback(null, address, address.includes(':') ? 6 : 4);
                },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let truncated = false;
          incoming.on('data', (chunk: Buffer) => {
            if (truncated) return;
            received += chunk.length;
            if (received > options.maxBytes) {
              truncated = true;
              chunks.push(chunk.subarray(0, chunk.length - (received - options.maxBytes)));
              incoming.destroy();
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('close', () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (value === undefined) continue;
              headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
            }
            resolve({
              status: incoming.statusCode ?? 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
              truncated,
            });
          });
          incoming.on('error', reject);
        },
      );
      outgoing.on('timeout', () => {
        outgoing.destroy(new Error(`request timed out after ${options.timeoutMs}ms`));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  };
}
