import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MANIFEST = '.shared-album-dl.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remembers which album items were already saved, so re-runs only fetch new ones. */
export class Manifest {
  constructor(dir, album) {
    this.path = join(dir, MANIFEST);
    this.data = { album: album.name, token: album.token, items: {} };
    if (existsSync(this.path)) {
      try {
        const prev = JSON.parse(readFileSync(this.path, 'utf8'));
        this.data.items = prev.items ?? {};
      } catch {
        /* corrupt manifest: start fresh, on-disk files are still detected by size */
      }
    }
  }
  /** Relative path of a previously saved item, if it is still on disk. */
  existing(dir, guid) {
    const rec = this.data.items[guid];
    return rec && existsSync(join(dir, rec.file)) ? rec.file : null;
  }
  record(guid, entry) {
    this.data.items[guid] = { ...entry, savedAt: new Date().toISOString() };
  }
  save() {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

/** Gives each item a unique path that never clobbers a different file already on disk. */
export function planPaths(items, template, render, { dir, manifest, force }) {
  const taken = new Set();
  const plan = [];
  for (const item of items) {
    const prev = force ? null : manifest.existing(dir, item.guid);
    if (prev) {
      taken.add(prev.toLowerCase());
      plan.push({ item, file: prev, status: 'have' });
      continue;
    }
    const wanted = render(item);
    const dot = wanted.lastIndexOf('.');
    const stem = wanted.slice(0, dot);
    const ext = wanted.slice(dot);
    let file = wanted;
    let status = 'todo';
    for (let n = 2; ; n++) {
      if (!taken.has(file.toLowerCase())) {
        const abs = join(dir, file);
        if (force || !existsSync(abs)) break;
        // Same name + same size on disk: treat as already downloaded (e.g. manifest was deleted).
        if (item.best && statSync(abs).size === item.best.fileSize) {
          status = 'have';
          break;
        }
      }
      file = `${stem}_${n}${ext}`;
    }
    taken.add(file.toLowerCase());
    plan.push({ item, file, status, adopted: status === 'have' });
  }
  return plan;
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Stream a URL to disk via a .part file, retrying transient failures. */
export async function downloadTo(url, dest, { onBytes = () => {}, signal, retries = 3, mtime, beforeRename } = {}) {
  const part = dest + '.part';
  await mkdir(dirname(dest), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let written = 0;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new HttpError(res.status);
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part), { signal });
      if (beforeRename) await beforeRename(part);
      await rename(part, dest);
      if (mtime && !Number.isNaN(mtime.getTime())) await utimes(dest, mtime, mtime).catch(() => {});
      return written;
    } catch (err) {
      onBytes(-written);
      await rm(part, { force: true });
      const permanent = err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (signal?.aborted || permanent || attempt >= retries) throw err;
      await sleep(700 * 2 ** attempt);
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Remove leftover .part files synchronously (used on Ctrl+C). */
export function cleanupParts(paths) {
  for (const p of paths) rmSync(p + '.part', { force: true });
}
