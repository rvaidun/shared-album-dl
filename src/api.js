// Minimal client for the public iCloud Shared Album ("sharedstreams") web API.
// This is the same unauthenticated API that www.icloud.com/sharedalbum uses,
// so it only works for albums with "Public Website" turned on.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const HEADERS = {
  Origin: 'https://www.icloud.com',
  Referer: 'https://www.icloud.com/sharedalbum/',
  'Accept-Language': 'en-US,en;q=0.8',
  'Content-Type': 'text/plain',
  Accept: '*/*',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.3gp']);

/** Accepts a full share URL (https://www.icloud.com/sharedalbum/#TOKEN) or a bare token. */
export function parseToken(input) {
  let s = String(input ?? '').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  s = s.split(';')[0];
  if (!/^[A-Za-z0-9_-]{10,}$/.test(s)) {
    throw new Error(`Not an iCloud shared album link or token: ${input}`);
  }
  return s;
}

const base62 = (str) => [...str].reduce((n, ch) => n * 62 + BASE62.indexOf(ch), 0);

export function baseUrlFor(token) {
  const partition = token[0] === 'A' ? base62(token[1]) : base62(token.slice(1, 3));
  const host = `p${String(partition).padStart(2, '0')}-sharedstreams.icloud.com`;
  return `https://${host}/${token}/sharedstreams/`;
}

async function post(url, body) {
  return fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), redirect: 'manual' });
}

async function postJson(url, body) {
  const res = await post(url, body);
  if (!res.ok) throw new Error(`iCloud returned HTTP ${res.status} for ${new URL(url).pathname.split('/').pop()}`);
  return res.json();
}

/** Last path segment of a CDN url, e.g. "IMG_1234.JPG". */
export function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

export function extOf(fileName) {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(fileName);
  return m ? m[0].toLowerCase() : '';
}

/** Choose the best-quality derivative that has a download URL. */
export function pickBest(item) {
  let candidates = item.derivatives.filter((d) => d.url);
  if (item.type === 'video') {
    const videos = candidates.filter((d) => VIDEO_EXTS.has(extOf(fileNameFromUrl(d.url))));
    if (videos.length) candidates = videos; // skip the JPEG poster frame
  }
  return candidates.sort((a, b) => b.width * b.height - a.width * a.height || b.fileSize - a.fileSize)[0];
}

function normalize(raw, urls) {
  const derivatives = Object.entries(raw.derivatives ?? {}).map(([key, d]) => ({
    key,
    checksum: d.checksum,
    fileSize: Number(d.fileSize) || 0,
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    url: urls[d.checksum],
  }));
  const first = raw.contributorFirstName ?? '';
  const last = raw.contributorLastName ?? '';
  const item = {
    guid: raw.photoGuid,
    batchGuid: raw.batchGuid,
    type: raw.mediaAssetType === 'video' ? 'video' : 'photo',
    uploader: (raw.contributorFullName || `${first} ${last}`).trim() || 'Unknown',
    uploaderFirst: first,
    uploaderLast: last,
    created: new Date(raw.dateCreated),
    uploaded: new Date(raw.batchDateCreated),
    caption: raw.caption ?? '',
    derivatives,
  };
  const best = pickBest(item);
  item.best = best ?? null;
  const original = best ? fileNameFromUrl(best.url) : '';
  item.ext = extOf(original) || (item.type === 'video' ? '.mp4' : '.jpg');
  item.name = original.replace(/\.[^.]+$/, '') || item.guid.slice(0, 8);
  return item;
}

/**
 * Fetch album metadata and resolved download URLs.
 * @param {string} token
 * @param {{ onProgress?: (done: number, total: number) => void }} [opts]
 */
export async function fetchAlbum(token, { onProgress } = {}) {
  let base = baseUrlFor(token);
  let res = await post(base + 'webstream', { streamCtag: null });

  // Apple answers 330 with the album's real host when the guessed partition is wrong.
  if (res.status === 330) {
    const host = (await res.json())['X-Apple-MMe-Host'];
    base = `https://${host}/${token}/sharedstreams/`;
    res = await post(base + 'webstream', { streamCtag: null });
  }
  if (res.status === 404) {
    throw new Error('Album not found. The link may be revoked, or "Public Website" is off for this album.');
  }
  if (!res.ok) throw new Error(`iCloud returned HTTP ${res.status} while loading the album`);
  const data = await res.json();
  const photos = data.photos ?? [];

  // Resolve CDN URLs in batches of 25 (the web client's batch size), a few batches at a time.
  const guids = photos.map((p) => p.photoGuid);
  const batches = [];
  for (let i = 0; i < guids.length; i += 25) batches.push(guids.slice(i, i + 25));
  const urls = {};
  let done = 0;
  onProgress?.(0, guids.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const body = await postJson(base + 'webasseturls', { photoGuids: batch });
      for (const [checksum, loc] of Object.entries(body.items ?? {})) {
        urls[checksum] = `https://${loc.url_location}${loc.url_path}`;
      }
      done += batch.length;
      onProgress?.(done, guids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));

  const items = photos.map((p) => normalize(p, urls)).sort((a, b) => a.created - b.created);
  items.forEach((it, i) => (it.index = i + 1));

  return {
    token,
    name: data.streamName || 'Shared Album',
    owner: `${data.userFirstName ?? ''} ${data.userLastName ?? ''}`.trim(),
    items,
  };
}
