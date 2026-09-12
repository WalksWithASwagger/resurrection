/**
 * Content-addressed body store.
 *
 * Bytes are kept before they are interpreted (docs/SPEC.md section 5.3). The
 * key is the local SHA-256 of exactly the bytes received, which is deliberately
 * a different thing from the archive's own digest: the archive digest describes
 * what the provider says it holds, the local hash describes what arrived here.
 *
 * URL identity and content identity stay separate. Two work items that receive
 * the same bytes share one object and keep two records.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StoredObject {
  hash: string;
  byteLength: number;
  /** The bytes were already present, so nothing was written. */
  deduplicated: boolean;
  /** Path relative to the store root, so a report stays portable. */
  relativePath: string;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class BodyStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  relativePathFor(hash: string): string {
    return join('objects', hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  absolutePathFor(hash: string): string {
    return join(this.root, this.relativePathFor(hash));
  }

  async put(bytes: Uint8Array): Promise<StoredObject> {
    const hash = sha256(bytes);
    const relativePath = this.relativePathFor(hash);
    const absolute = join(this.root, relativePath);
    const existing = await stat(absolute).catch(() => null);
    if (existing !== null) {
      return { hash, byteLength: bytes.length, deduplicated: true, relativePath };
    }
    await mkdir(dirname(absolute), { recursive: true });
    // Write then rename so a crash never leaves a partial object under a hash
    // that claims to describe complete bytes.
    const temporary = `${absolute}.${process.pid}.partial`;
    await writeFile(temporary, bytes);
    await rename(temporary, absolute);
    return { hash, byteLength: bytes.length, deduplicated: false, relativePath };
  }

  async has(hash: string): Promise<boolean> {
    return (await stat(this.absolutePathFor(hash)).catch(() => null)) !== null;
  }

  async read(hash: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.absolutePathFor(hash)));
  }
}
