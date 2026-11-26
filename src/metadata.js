// Write capture dates into downloaded files, without external tools.
//
// - JPEG: if the photo has no EXIF DateTimeOriginal (common for images that were
//   saved from WhatsApp/Messages before being shared), add DateTimeOriginal,
//   CreateDate, ModifyDate and their time-zone offsets. Existing EXIF tags
//   (GPS, colour space, …) are kept. Photos that already have a date are untouched.
// - MP4/MOV: Apple re-encodes shared-album videos and stamps them with the upload
//   time. Overwrite the creation/modification dates in mvhd, tkhd and mdhd with the
//   real capture time. These are fixed-size fields, so the file size never changes.

import { open, readFile, writeFile } from 'node:fs/promises';
import { dateParts } from './naming.js';

const pad = (n) => String(n).padStart(2, '0');

/** "+HH:MM" offset of `tz` (or the system zone) at instant `d`. */
export function offsetString(d, tz) {
  const p = dateParts(d, tz);
  const wall = Date.UTC(p.Y, p.M - 1, p.D, p.h, p.m, p.s);
  const mins = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** EXIF local time "YYYY:MM:DD HH:MM:SS" in `tz`. */
export function exifDate(d, tz) {
  const p = dateParts(d, tz);
  return `${p.Y}:${pad(p.M)}:${pad(p.D)} ${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
}

// ─────────────────────────────── JPEG / EXIF ───────────────────────────────

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const EXIF_IFD = 0x8769;
const GPS_IFD = 0x8825;
const INTEROP_IFD = 0xa005;
const SUB_IFDS = { 0: [EXIF_IFD, GPS_IFD], [EXIF_IFD]: [INTEROP_IFD] };
const MAKER_NOTE = 0x927c; // contains absolute offsets; unsafe to relocate
const T = {
  ModifyDate: 0x0132,
  DateTimeOriginal: 0x9003,
  CreateDate: 0x9004,
  OffsetTime: 0x9010,
  OffsetTimeOriginal: 0x9011,
  OffsetTimeDigitized: 0x9012,
};

const newIfd = () => ({ entries: new Map(), subs: new Map() });

/** Parse a TIFF/EXIF blob into { le, ifd0 } (IFD1/thumbnail is dropped). Throws on malformed data. */
export function readTiff(tiff) {
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new Error('bad TIFF byte order');
  const le = order === 'II';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('bad TIFF magic');
  const seen = new Set();

  const readIfd = (off, kind) => {
    if (seen.has(off) || off + 2 > tiff.length) throw new Error('bad IFD offset');
    seen.add(off);
    const ifd = newIfd();
    const n = u16(off);
    if (off + 2 + n * 12 > tiff.length) throw new Error('IFD out of range');
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      const tag = u16(p);
      const type = u16(p + 2);
      const count = u32(p + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (!TYPE_SIZE[type]) continue; // unknown type: drop it
      if ((SUB_IFDS[kind] ?? []).includes(tag)) {
        ifd.subs.set(tag, readIfd(u32(p + 8), tag));
        continue;
      }
      if (tag === MAKER_NOTE) continue;
      const start = size <= 4 ? p + 8 : u32(p + 8);
      if (start + size > tiff.length) throw new Error('value out of range');
      ifd.entries.set(tag, { type, count, bytes: Buffer.from(tiff.subarray(start, start + size)) });
    }
    return ifd;
  };
  return { le, ifd0: readIfd(u32(4), 0) };
}

/** Serialize { le, ifd0 } back into a TIFF blob. */
export function writeTiff({ le, ifd0 }) {
  const dataLen = (e) => (e.bytes.length > 4 ? e.bytes.length + (e.bytes.length & 1) : 0);
  const count = (ifd) => ifd.entries.size + ifd.subs.size;
  const blockSize = (ifd) => 2 + 12 * count(ifd) + 4 + [...ifd.entries.values()].reduce((s, e) => s + dataLen(e), 0);
  const totalSize = (ifd) => blockSize(ifd) + [...ifd.subs.values()].reduce((s, sub) => s + totalSize(sub), 0);

  const out = Buffer.alloc(8 + totalSize(ifd0));
  const w16 = (v, o) => (le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const w32 = (v, o) => (le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  out.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2);
  w32(8, 4);

  const emit = (ifd, start) => {
    let subStart = start + blockSize(ifd);
    const rows = [...ifd.entries.entries()].map(([tag, e]) => ({ tag, ...e }));
    const subPlacements = [];
    for (const [tag, sub] of ifd.subs) {
      rows.push({ tag, type: 4, count: 1, pointer: subStart });
      subPlacements.push([sub, subStart]);
      subStart += totalSize(sub);
    }
    rows.sort((a, b) => a.tag - b.tag);
    w16(rows.length, start);
    let data = start + 2 + rows.length * 12 + 4;
    rows.forEach((r, i) => {
      const p = start + 2 + i * 12;
      w16(r.tag, p);
      w16(r.type, p + 2);
      w32(r.count, p + 4);
      if (r.pointer !== undefined) w32(r.pointer, p + 8);
      else if (r.bytes.length <= 4) r.bytes.copy(out, p + 8);
      else {
        w32(data, p + 8);
        r.bytes.copy(out, data);
        data += r.bytes.length + (r.bytes.length & 1);
      }
    });
    w32(0, start + 2 + rows.length * 12); // no next IFD
    for (const [sub, at] of subPlacements) emit(sub, at);
  };
  emit(ifd0, 8);
  return out;
}

const ascii = (s) => {
  const bytes = Buffer.from(s + '\0', 'latin1');
  return { type: 2, count: bytes.length, bytes };
};

/** Walk JPEG segments up to the image data. */
function jpegSegments(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const segs = [];
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) throw new Error('bad JPEG marker');
    const marker = buf[p + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    const len = buf.readUInt16BE(p + 2);
    segs.push({ marker, start: p, end: p + 2 + len });
    if (marker === 0xda) break; // start of scan: image data follows
    p += 2 + len;
  }
  return segs;
}

const isExifSeg = (buf, s) => s.marker === 0xe1 && buf.toString('latin1', s.start + 4, s.start + 10) === 'Exif\0\0';

/** Returns the patched JPEG buffer, or null when it already has a capture date. */
export function addJpegDate(buf, date, tz) {
  const segs = jpegSegments(buf);
  const exifSeg = segs.find((s) => isExifSeg(buf, s));

  let tiff;
  if (exifSeg) {
    tiff = readTiff(buf.subarray(exifSeg.start + 10, exifSeg.end));
    const exif = tiff.ifd0.subs.get(EXIF_IFD);
    if (exif?.entries.has(T.DateTimeOriginal)) return null;
  } else {
    tiff = { le: false, ifd0: newIfd() };
  }
  const { ifd0 } = tiff;
  if (!ifd0.subs.has(EXIF_IFD)) ifd0.subs.set(EXIF_IFD, newIfd());
  const exif = ifd0.subs.get(EXIF_IFD);

  const local = exifDate(date, tz);
  const offset = offsetString(date, tz);
  const setIfMissing = (ifd, tag, value) => ifd.entries.has(tag) || ifd.entries.set(tag, ascii(value));
  setIfMissing(ifd0, T.ModifyDate, local);
  exif.entries.set(T.DateTimeOriginal, ascii(local));
  setIfMissing(exif, T.CreateDate, local);
  setIfMissing(exif, T.OffsetTimeOriginal, offset);
  setIfMissing(exif, T.OffsetTimeDigitized, offset);
  setIfMissing(exif, T.OffsetTime, offset);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), writeTiff(tiff)]);
  if (payload.length + 2 > 0xffff) throw new Error('EXIF block too large');
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  const segment = Buffer.concat([app1, payload]);

  if (exifSeg) {
    return Buffer.concat([buf.subarray(0, exifSeg.start), segment, buf.subarray(exifSeg.end)]);
  }
  // Insert after SOI and any leading APP0 (JFIF) segments.
  let at = 2;
  for (const s of segs) {
    if (s.marker !== 0xe0) break;
    at = s.end;
  }
  return Buffer.concat([buf.subarray(0, at), segment, buf.subarray(at)]);
}

/** Read EXIF DateTimeOriginal from a JPEG buffer (or null). */
export function readJpegDate(buf) {
  const seg = jpegSegments(buf).find((s) => isExifSeg(buf, s));
  if (!seg) return null;
  const e = readTiff(buf.subarray(seg.start + 10, seg.end)).ifd0.subs.get(EXIF_IFD)?.entries.get(T.DateTimeOriginal);
  return e ? e.bytes.toString('latin1').replace(/\0+$/, '') : null;
}

// ─────────────────────────────── MP4 / MOV ───────────────────────────────

const MAC_EPOCH = 2082844800; // seconds between 1904-01-01 and 1970-01-01

function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, start: p, body: p + header, end: p + size };
    p += size;
  }
}

/** Patch creation/modification times inside a moov box buffer. Returns the number of boxes changed. */
export function patchMoov(moov, date) {
  const secs = BigInt(Math.floor(date.getTime() / 1000) + MAC_EPOCH);
  let changed = 0;
  const stamp = (b) => {
    const version = moov[b.body];
    const t = b.body + 4;
    if (version === 1 && t + 16 <= b.end) {
      moov.writeBigUInt64BE(secs, t);
      moov.writeBigUInt64BE(secs, t + 8);
      changed++;
    } else if (version === 0 && t + 8 <= b.end) {
      moov.writeUInt32BE(Number(secs & 0xffffffffn), t);
      moov.writeUInt32BE(Number(secs & 0xffffffffn), t + 4);
      changed++;
    }
  };
  const walk = (start, end) => {
    for (const b of boxes(moov, start, end)) {
      if (b.type === 'mvhd' || b.type === 'tkhd' || b.type === 'mdhd') stamp(b);
      else if (b.type === 'moov' || b.type === 'trak' || b.type === 'mdia') walk(b.body, b.end);
    }
  };
  walk(0, moov.length);
  return changed;
}

/** Find the top-level moov box in a file and patch it in place. */
export async function setVideoDate(path, date) {
  const fh = await open(path, 'r+');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let p = 0;
    while (p + 8 <= size) {
      await fh.read(head, 0, 16, p);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - p;
      if (boxSize < 8 || p + boxSize > size) break;
      if (type === 'moov') {
        if (boxSize > 64 * 1024 * 1024) throw new Error('moov box too large');
        const moov = Buffer.alloc(boxSize);
        await fh.read(moov, 0, boxSize, p);
        const changed = patchMoov(moov, date);
        if (changed) await fh.write(moov, 0, boxSize, p);
        return changed > 0;
      }
      p += boxSize;
    }
    return false;
  } finally {
    await fh.close();
  }
}

// ─────────────────────────────── entry ───────────────────────────────

/**
 * Write the capture date into a downloaded file. Returns true if the file changed.
 * Never throws: a file we can't parse is simply left as Apple served it.
 */
export async function writeCaptureDate(path, ext, date, tz) {
  if (!date || Number.isNaN(date.getTime())) return false;
  try {
    if (ext === '.jpg' || ext === '.jpeg') {
      const buf = await readFile(path);
      const patched = addJpegDate(buf, date, tz);
      if (!patched) return false;
      await writeFile(path, patched);
      return true;
    }
    if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') return await setVideoDate(path, date);
  } catch {
    /* leave the file untouched */
  }
  return false;
}
