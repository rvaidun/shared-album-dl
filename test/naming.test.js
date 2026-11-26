import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToken, baseUrlFor, pickBest } from '../src/api.js';
import { renderName, resolveTemplate, nameMatches, PRESETS } from '../src/naming.js';
import { Manifest, planPaths } from '../src/download.js';

const item = (over = {}) => ({
  guid: '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
  type: 'photo',
  uploader: 'Jane Appleseed',
  uploaderFirst: 'Jane',
  uploaderLast: 'Appleseed',
  created: new Date('2026-11-25T21:31:16Z'),
  uploaded: new Date('2026-11-26T06:04:22Z'),
  caption: '',
  name: 'IMG_1234',
  ext: '.jpg',
  index: 7,
  best: { fileSize: 10 },
  ...over,
});

test('parseToken accepts urls and bare tokens', () => {
  const t = 'B0aB2abcdefGHIJ_klm-nop';
  assert.equal(parseToken(`https://www.icloud.com/sharedalbum/#${t}`), t);
  assert.equal(parseToken(`https://www.icloud.com/sharedalbum/#${t};B0abc`), t);
  assert.equal(parseToken(t), t);
  assert.throws(() => parseToken('https://example.com'));
});

test('baseUrlFor derives the partition host', () => {
  assert.match(baseUrlFor('A1aaaaaaaaaaaa'), /^https:\/\/p01-sharedstreams\.icloud\.com\//);
  assert.match(baseUrlFor('B0aB2abcdefGHIJ'), /^https:\/\/p\d+-sharedstreams\.icloud\.com\//);
});

test('pickBest prefers the video stream over the poster frame', () => {
  const best = pickBest({
    type: 'video',
    derivatives: [
      { url: 'https://x/IMG_1.JPG', width: 720, height: 1280, fileSize: 500 },
      { url: 'https://x/IMG_1.mp4', width: 360, height: 640, fileSize: 2000 },
      { url: 'https://x/IMG_1.mp4', width: 720, height: 1280, fileSize: 6000 },
    ],
  });
  assert.equal(best.fileSize, 6000);
});

test('default template keeps uploader and original name', () => {
  const name = renderName(resolveTemplate('default'), item(), { timeZone: 'Pacific/Honolulu' });
  assert.equal(name, '2026-11-25_11-31-16_Jane-Appleseed_IMG_1234.jpg');
});

test('every preset renders', () => {
  for (const preset of Object.keys(PRESETS)) {
    assert.ok(renderName(resolveTemplate(preset), item(), { album: 'Summer Trip', timeZone: 'UTC' }).endsWith('.jpg'));
  }
});

test('templates sanitise names and collapse empty tokens', () => {
  const it = item({ uploader: 'A/B: C', uploaderLast: '' });
  assert.equal(renderName('{uploader}_{uploader_last}_{name}', it), 'AB-C_IMG_1234.jpg');
  assert.equal(renderName('{uploader}/{name}', item()), 'Jane-Appleseed/IMG_1234.jpg');
});

test('unknown tokens are rejected', () => {
  assert.throws(() => resolveTemplate('{nope}_{name}'), /Unknown token \{nope\}/);
  assert.throws(() => resolveTemplate('plain'), /not a preset/);
});

test('nameMatches uses whole words', () => {
  assert.ok(nameMatches('John Appleseed', 'john'));
  assert.ok(nameMatches('John Appleseed', 'JOHN APPLESEED'));
  assert.ok(nameMatches('José Núñez', 'jose nunez'));
  assert.ok(!nameMatches('Ann Smithson', 'smith'));
  assert.ok(!nameMatches('John Appleseed', ''));
});

test('planPaths de-duplicates names and adopts identical files on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sadl-'));
  writeFileSync(join(dir, 'IMG_1.jpg'), 'x'.repeat(10)); // same size as item.best -> adopted
  writeFileSync(join(dir, 'IMG_2.jpg'), 'different');    // different file -> must not clobber
  const manifest = new Manifest(dir, { name: 'A', token: 't' });
  const a = item({ guid: 'a', name: 'IMG_1' });
  const b = item({ guid: 'b', name: 'IMG_2' });
  const c = item({ guid: 'c', name: 'IMG_2' });
  const plan = planPaths([a, b, c], '{name}', (it) => renderName('{name}', it), { dir, manifest });
  assert.deepEqual(plan.map((p) => [p.file, p.status]), [
    ['IMG_1.jpg', 'have'],
    ['IMG_2_2.jpg', 'todo'],
    ['IMG_2_3.jpg', 'todo'],
  ]);
});
