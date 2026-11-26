// Filename templates: "{date}_{time}_{uploader}_{name}" -> "2026-11-25_12-43-49_Jane-Appleseed_IMG_1234.jpg"

const pad = (n, w = 2) => String(n).padStart(w, '0');
const clean = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const dashed = (s) => clean(s).replace(/ /g, '-');

const formatters = new Map();
/** Calendar parts of `d` in an IANA time zone (or the system zone when `tz` is empty). */
export function dateParts(d, tz) {
  if (!tz) {
    return { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  }
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const o = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, Number(p.value)]));
  return { Y: o.year, M: o.month, D: o.day, h: o.hour, m: o.minute, s: o.second };
}
const ymd = (d, tz) => { const p = dateParts(d, tz); return `${p.Y}-${pad(p.M)}-${pad(p.D)}`; };
const hms = (d, tz) => { const p = dateParts(d, tz); return `${pad(p.h)}-${pad(p.m)}-${pad(p.s)}`; };

export const TOKENS = {
  uploader: { desc: 'Uploader full name (spaces → dashes)', get: (it) => dashed(it.uploader) },
  uploader_first: { desc: 'Uploader first name', get: (it) => dashed(it.uploaderFirst || it.uploader.split(' ')[0]) },
  uploader_last: { desc: 'Uploader last name', get: (it) => dashed(it.uploaderLast) },
  initials: {
    desc: 'Uploader initials',
    get: (it) => clean(it.uploader).split(' ').map((w) => w[0]?.toUpperCase() ?? '').join(''),
  },
  name: { desc: 'Original file name without extension', get: (it) => clean(it.name) },
  date: { desc: 'Capture date (YYYY-MM-DD)', get: (it, ctx) => ymd(it.created, ctx.timeZone) },
  time: { desc: 'Capture time (HH-MM-SS)', get: (it, ctx) => hms(it.created, ctx.timeZone) },
  datetime: {
    desc: 'Compact capture date + time',
    get: (it, ctx) => `${ymd(it.created, ctx.timeZone).replace(/-/g, '')}_${hms(it.created, ctx.timeZone).replace(/-/g, '')}`,
  },
  year: { desc: 'Capture year', get: (it, ctx) => String(dateParts(it.created, ctx.timeZone).Y) },
  month: { desc: 'Capture month (01-12)', get: (it, ctx) => pad(dateParts(it.created, ctx.timeZone).M) },
  day: { desc: 'Capture day (01-31)', get: (it, ctx) => pad(dateParts(it.created, ctx.timeZone).D) },
  uploaded: { desc: 'Date it was added to the album', get: (it, ctx) => ymd(it.uploaded, ctx.timeZone) },
  type: { desc: '"photo" or "video"', get: (it) => it.type },
  album: { desc: 'Album name', get: (_, ctx) => clean(ctx.album) },
  owner: { desc: 'Album owner name', get: (_, ctx) => dashed(ctx.owner) },
  index: { desc: 'Position in album, oldest first (zero-padded)', get: (it, ctx) => pad(it.index, ctx.indexWidth ?? 4) },
  guid: { desc: 'Short unique iCloud id', get: (it) => it.guid.slice(0, 8) },
  caption: { desc: 'Caption (first 60 chars)', get: (it) => clean(it.caption).slice(0, 60) },
};

export const PRESETS = {
  default: '{date}_{time}_{uploader}_{name}',
  'by-uploader': '{uploader}_{date}_{time}_{name}',
  compact: '{datetime}_{initials}_{name}',
  original: '{name}_{uploader}',
  folders: '{uploader}/{date}_{time}_{name}',
  indexed: '{index}_{uploader}_{name}',
};

export function resolveTemplate(formatOrPreset = 'default') {
  const template = PRESETS[formatOrPreset] ?? formatOrPreset;
  const unknown = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !TOKENS[k]);
  if (unknown.length) {
    throw new Error(
      `Unknown token${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `{${k}}`).join(', ')}. ` +
        `Run "shared-album-dl formats" to see what is available.`,
    );
  }
  if (!/\{\w+\}/.test(template)) {
    throw new Error(`"${formatOrPreset}" is not a preset and has no {tokens}. Presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  return template;
}

/** Render a template into a relative path (may contain "/" for sub-folders), extension included. */
export function renderName(template, item, ctx = {}) {
  const raw = template.replace(/\{(\w+)\}/g, (_, k) => TOKENS[k].get(item, ctx));
  const segments = raw
    .split('/')
    .map((seg) =>
      seg
        .replace(/[\\:*?"<>|\x00-\x1f]/g, '')
        .replace(/([_.-])\1+/g, '$1') // collapse "__" left by empty tokens
        .replace(/^[\s._-]+|[\s_-]+$/g, '')
        .slice(0, 180),
    )
    .filter(Boolean);
  if (!segments.length) segments.push(item.guid.slice(0, 8));
  return segments.join('/') + item.ext;
}

const words = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * True when every word of `pattern` is a whole word of `name`, case/accent-insensitive.
 * "john" and "John Appleseed" match "John Appleseed"; "smith" does NOT match "Ann Smithson".
 */
export function nameMatches(name, pattern) {
  const have = new Set(words(name));
  const want = words(pattern);
  return want.length > 0 && want.every((w) => have.has(w));
}
