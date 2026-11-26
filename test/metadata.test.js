import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addJpegDate, readJpegDate, readTiff, writeTiff, offsetString, exifDate, patchMoov, setVideoDate, writeCaptureDate,
} from '../src/metadata.js';

const date = new Date('2026-11-21T01:55:17Z');

// SOI + APP0(JFIF) + fake scan + EOI
const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0]);
const scan = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x12, 0x34, 0x56, 0xff, 0xd9]);
const jpeg = (...segs) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, scan]);

/** EXIF APP1 with only ColorSpace (0xA001) in the Exif IFD, little-endian. */
function exifApp1({ withDate = false } = {}) {
  const exif = { entries: new Map([[0xa001, { type: 3, count: 1, bytes: Buffer.from([1, 0]) }]]), subs: new Map() };
  if (withDate) exif.entries.set(0x9003, { type: 2, count: 20, bytes: Buffer.from('2020:01:02 03:04:05\0', 'latin1') });
  const tiff = writeTiff({ le: true, ifd0: { entries: new Map(), subs: new Map([[0x8769, exif]]) } });
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

test('offsetString and exifDate honour the time zone', () => {
  assert.equal(offsetString(date, 'Pacific/Honolulu'), '-10:00');
  assert.equal(offsetString(date, 'America/Los_Angeles'), '-08:00');
  assert.equal(offsetString(date, 'Asia/Kolkata'), '+05:30');
  assert.equal(exifDate(date, 'America/Los_Angeles'), '2026:11:20 17:55:17');
});

test('adds an EXIF block to a JPEG that has none', () => {
  const out = addJpegDate(jpeg(jfif), date, 'America/Los_Angeles');
  assert.equal(readJpegDate(out), '2026:11:20 17:55:17');
  assert.ok(out.subarray(-scan.length).equals(scan), 'image data untouched');
  assert.ok(out.subarray(2, 2 + jfif.length).equals(jfif), 'JFIF stays first');
});

test('keeps existing EXIF tags when adding a date', () => {
  const out = addJpegDate(jpeg(jfif, exifApp1()), date, 'UTC');
  assert.equal(readJpegDate(out), '2026:11:21 01:55:17');
  const start = out.indexOf('Exif\0\0', 0, 'latin1') + 6;
  const exif = readTiff(out.subarray(start)).ifd0.subs.get(0x8769);
  assert.deepEqual([...exif.entries.get(0xa001).bytes], [1, 0], 'ColorSpace preserved');
  assert.ok(exif.entries.has(0x9011), 'OffsetTimeOriginal added');
});

test('never modifies a JPEG that already has a capture date', () => {
  assert.equal(addJpegDate(jpeg(jfif, exifApp1({ withDate: true })), date, 'UTC'), null);
});

test('TIFF round-trips', () => {
  const ifd0 = { entries: new Map([[0x010f, { type: 2, count: 6, bytes: Buffer.from('Apple\0') }]]), subs: new Map() };
  for (const le of [true, false]) {
    const back = readTiff(writeTiff({ le, ifd0 }));
    assert.equal(back.ifd0.entries.get(0x010f).bytes.toString(), 'Apple\0');
  }
});

// ── MP4 ──
const box = (type, ...children) => {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const fullBox = (type, version) => {
  const body = Buffer.alloc(version === 1 ? 4 + 16 + 8 : 4 + 8 + 8);
  body[0] = version;
  return box(type, body);
};
const MAC_EPOCH = 2082844800;

test('patchMoov stamps mvhd, tkhd and mdhd (v0 and v1)', () => {
  const moov = box('moov', fullBox('mvhd', 0), box('trak', fullBox('tkhd', 0), box('mdia', fullBox('mdhd', 1))));
  assert.equal(patchMoov(moov, date), 3);
  const secs = Math.floor(date.getTime() / 1000) + MAC_EPOCH;
  const mvhd = moov.indexOf('mvhd', 0, 'latin1') + 4;
  assert.equal(moov.readUInt32BE(mvhd + 4), secs);
  const mdhd = moov.indexOf('mdhd', 0, 'latin1') + 4;
  assert.equal(Number(moov.readBigUInt64BE(mdhd + 4)), secs);
});

test('setVideoDate patches a file in place without changing its size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sadl-'));
  const file = join(dir, 'v.mp4');
  const data = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', fullBox('mvhd', 0)), box('mdat', Buffer.alloc(32, 7))]);
  writeFileSync(file, data);
  assert.equal(await setVideoDate(file, date), true);
  const after = readFileSync(file);
  assert.equal(after.length, data.length);
  assert.ok(after.subarray(-32).equals(Buffer.alloc(32, 7)), 'media data untouched');
});

test('writeCaptureDate leaves unparseable files alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sadl-'));
  const file = join(dir, 'broken.jpg');
  writeFileSync(file, 'not a jpeg');
  assert.equal(await writeCaptureDate(file, '.jpg', date), false);
  assert.equal(readFileSync(file, 'utf8'), 'not a jpeg');
});
