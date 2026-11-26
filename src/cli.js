import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fetchAlbum, parseToken } from './api.js';
import { PRESETS, TOKENS, nameMatches, renderName, resolveTemplate } from './naming.js';
import { Manifest, cleanupParts, downloadTo, planPaths, pool } from './download.js';
import { writeCaptureDate } from './metadata.js';
import { c, ce, sym, bytes, duration, table, Spinner, Progress } from './ui.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const BIN = 'shared-album-dl';
const ENV_EXCLUDE = 'SHARED_ALBUM_DL_EXCLUDE';

const HELP = `
${c.title(BIN)} ${c.dim('v' + pkg.version)}
Download an iCloud Shared Album (public link), keeping who uploaded each photo in the file name.

${c.bold('Usage')}
  ${BIN} ${c.cyan('<link>')} [options]            ${c.dim('same as "download"')}
  ${BIN} ${c.green('download')} ${c.cyan('<link>')} [options]   Download photos and videos
  ${BIN} ${c.green('info')} ${c.cyan('<link>')}                 Show album contents per contributor
  ${BIN} ${c.green('formats')} [${c.cyan('<link>')}]            List file-name tokens and presets

${c.bold('Download options')}
  ${c.yellow('-x, --exclude')} <name>     Skip items uploaded by <name> (repeatable). Matches whole
                          words, case-insensitive: "jane" matches "Jane Appleseed".
  ${c.yellow('    --only')} <name>        Only items uploaded by <name> (repeatable)
  ${c.yellow('-o, --out')} <dir>          Output folder ${c.dim('(default: ./<album name>)')}
  ${c.yellow('-f, --format')} <fmt>       Preset or template ${c.dim('(default: "default")')}
  ${c.yellow('    --photos')}             Photos only
  ${c.yellow('    --videos')}             Videos only
  ${c.yellow('    --since')} <date>       Only items captured on/after date (YYYY-MM-DD)
  ${c.yellow('    --until')} <date>       Only items captured on/before date
  ${c.yellow('    --tz')} <zone>          Time zone for {date}/{time}, e.g. Pacific/Honolulu
                          ${c.dim('(default: this computer\'s zone)')}
  ${c.yellow('    --no-fix-dates')}       Don't write capture dates into files (see below)
  ${c.yellow('-j, --concurrency')} <n>    Parallel downloads ${c.dim('(default: 6)')}
  ${c.yellow('-n, --dry-run')}            Show what would be downloaded, don't download
  ${c.yellow('    --force')}              Re-download even if already saved
  ${c.yellow('    --all')}                Ignore $${ENV_EXCLUDE}
  ${c.yellow('-v, --verbose')}            Print every file as it finishes
  ${c.yellow('-h, --help')}               Show this help
  ${c.yellow('    --version')}            Show version

${c.bold('Dates')}
  Photos without a "date taken" get one from the album, and videos (which Apple
  stamps with the upload time) get their real capture time, so Google Photos sorts
  them correctly. Photos that already have EXIF dates are never modified.

${c.bold('Environment')}
  ${c.yellow(ENV_EXCLUDE)}   Comma-separated names to always exclude (e.g. yourself)
  ${c.yellow('NO_COLOR')} / ${c.yellow('FORCE_COLOR')}         Disable / force colors

${c.bold('Examples')}
  ${c.dim('# Everything except what I uploaded myself')}
  ${BIN} 'https://www.icloud.com/sharedalbum/#B0aB...' -x "Jane Doe"

  ${c.dim('# One folder per uploader')}
  ${BIN} '<link>' -f folders -o ~/Pictures/Trip

  ${c.dim('# Custom name: 2026-11-25_Jane-Appleseed_IMG_1234.jpg')}
  ${BIN} '<link>' -f '{date}_{uploader}_{name}'

Re-running into the same folder only downloads new items.
`;

function fail(msg, hint) {
  process.stderr.write(`${ce.err(sym.fail + ' Error:')} ${msg}\n`);
  if (hint) process.stderr.write(`  ${ce.dim(hint)}\n`);
  process.exit(1);
}

function parseDate(s, flag, endOfDay = false) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail(`${flag} expects YYYY-MM-DD, got "${s}"`);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

async function loadAlbum(link) {
  if (!link) fail('Missing album link.', `Usage: ${BIN} <link>   (see ${BIN} --help)`);
  let token;
  try {
    token = parseToken(link);
  } catch (e) {
    fail(e.message, 'Expected something like https://www.icloud.com/sharedalbum/#B0aB…');
  }
  const spin = new Spinner('Loading album').start();
  try {
    const album = await fetchAlbum(token, {
      onProgress: (done, total) => spin.update(`Resolving download links ${ce.dim(`${done}/${total}`)}`),
    });
    spin.stop();
    return album;
  } catch (e) {
    spin.stop();
    fail(e.message);
  }
}

function header(album) {
  const photos = album.items.filter((i) => i.type === 'photo').length;
  const videos = album.items.length - photos;
  const size = album.items.reduce((s, i) => s + (i.best?.fileSize ?? 0), 0);
  const first = album.items[0]?.created;
  const last = album.items.at(-1)?.created;
  const d = (x) => x?.toISOString().slice(0, 10);
  console.log();
  console.log(`  ${c.title(album.name)}${album.owner ? c.dim('  shared by ') + album.owner : ''}`);
  console.log(
    `  ${c.bold(album.items.length)} items ${c.dim('·')} ${photos} photos ${c.dim('·')} ${videos} videos ${c.dim('·')} ${bytes(size)}` +
      (first ? `  ${c.dim(`${d(first)} ${sym.arrow} ${d(last)}`)}` : ''),
  );
  console.log();
}

function contributorTable(items, isIncluded) {
  const by = new Map();
  for (const it of items) {
    const row = by.get(it.uploader) ?? { photos: 0, videos: 0, size: 0 };
    row[it.type === 'video' ? 'videos' : 'photos']++;
    row.size += it.best?.fileSize ?? 0;
    by.set(it.uploader, row);
  }
  const rows = [...by.entries()]
    .sort((a, b) => b[1].photos + b[1].videos - (a[1].photos + a[1].videos))
    .map(([name, r]) => {
      const inc = isIncluded ? isIncluded(name) : true;
      const mark = isIncluded ? (inc ? c.green(sym.ok) : c.red(sym.fail)) : c.cyan(sym.bullet);
      const label = inc ? name : c.dim(c.italic(name) + '  excluded');
      return [`${mark} ${label}`, String(r.photos), String(r.videos), bytes(r.size)];
    });
  console.log(table(['  Uploader', 'Photos', 'Videos', 'Size'], rows, ['l', 'r', 'r', 'r']));
  console.log();
}

/** Album-only metadata that is not inside the file itself. */
const recordFor = ({ item, file }) => ({
  file,
  type: item.type,
  uploader: item.uploader,
  captured: item.created.toISOString(),
  addedToAlbum: item.uploaded.toISOString(),
  caption: item.caption || undefined,
  width: item.best.width,
  height: item.best.height,
  checksum: item.best.checksum,
});

// ───────────────────────────── commands ─────────────────────────────

async function cmdInfo(args) {
  const album = await loadAlbum(args[0]);
  header(album);
  contributorTable(album.items);
}

async function cmdFormats(args) {
  let sample = {
    guid: '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
    type: 'photo',
    uploader: 'Jane Appleseed',
    uploaderFirst: 'Jane',
    uploaderLast: 'Appleseed',
    created: new Date(2026, 10, 25, 12, 43, 49),
    uploaded: new Date(2026, 10, 26),
    caption: 'Sunset at the beach',
    name: 'IMG_1234',
    ext: '.jpg',
    index: 42,
  };
  let ctx = { album: 'Summer Trip', owner: 'John Appleseed' };
  if (args[0]) {
    const album = await loadAlbum(args[0]);
    sample = album.items.find((i) => i.type === 'photo') ?? album.items[0] ?? sample;
    ctx = { album: album.name, owner: album.owner };
  }

  console.log(`\n${c.bold('Tokens')} ${c.dim(`(example item by ${sample.uploader})`)}\n`);
  console.log(
    table(
      ['Token', 'Example', 'Meaning'],
      Object.entries(TOKENS).map(([k, t]) => [c.yellow(`{${k}}`), t.get(sample, ctx) || c.dim('(empty)'), c.dim(t.desc)]),
    ),
  );
  console.log(`\n${c.bold('Presets')}  ${c.dim('use with -f <preset>')}\n`);
  console.log(
    table(
      ['Preset', 'Template', 'Result'],
      Object.entries(PRESETS).map(([k, t]) => [
        k === 'default' ? c.green(k) + c.dim(' *') : c.green(k),
        c.dim(t),
        renderName(t, sample, ctx),
      ]),
    ),
  );
  console.log(
    `\n  ${c.dim('Custom:')} -f '{year}/{month}/{date}_{uploader}_{name}'  ${c.dim('— "/" makes sub-folders,')}` +
      `\n  ${c.dim('the extension is added for you, and name clashes get _2, _3, …')}\n`,
  );
}

async function cmdDownload(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        exclude: { type: 'string', short: 'x', multiple: true },
        only: { type: 'string', multiple: true },
        out: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f', default: 'default' },
        photos: { type: 'boolean' },
        videos: { type: 'boolean' },
        since: { type: 'string' },
        until: { type: 'string' },
        tz: { type: 'string' },
        'no-fix-dates': { type: 'boolean' },
        concurrency: { type: 'string', short: 'j', default: '6' },
        'dry-run': { type: 'boolean', short: 'n' },
        force: { type: 'boolean' },
        all: { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    fail(e.message, `See ${BIN} --help`);
  }
  const { values: o, positionals } = parsed;
  if (positionals.length > 1) fail(`Expected one album link, got ${positionals.length}.`, 'Quote the link: it contains "#".');

  let template;
  try {
    template = resolveTemplate(o.format);
  } catch (e) {
    fail(e.message);
  }
  const concurrency = Number.parseInt(o.concurrency, 10);
  if (!(concurrency >= 1 && concurrency <= 32)) fail('--concurrency must be between 1 and 32');
  if (o.photos && o.videos) fail('--photos and --videos are mutually exclusive');
  if (o.tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: o.tz });
    } catch {
      fail(`Unknown time zone "${o.tz}"`, 'Use an IANA name like America/Los_Angeles or Pacific/Honolulu');
    }
  }
  const since = parseDate(o.since, '--since');
  const until = parseDate(o.until, '--until', true);

  const envExcludes = o.all ? [] : (process.env[ENV_EXCLUDE] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const excludes = [...envExcludes, ...(o.exclude ?? [])];
  const only = o.only ?? [];

  const album = await loadAlbum(positionals[0]);
  header(album);

  const uploaders = new Set(album.items.map((i) => i.uploader));
  for (const pat of [...excludes, ...only]) {
    if (![...uploaders].some((u) => nameMatches(u, pat))) {
      console.log(`  ${c.warn('!')} ${c.yellow(`"${pat}" doesn't match any uploader`)} ${c.dim(`(${[...uploaders].join(', ')})`)}`);
    }
  }
  const includedUploader = (name) =>
    !excludes.some((p) => nameMatches(name, p)) && (only.length === 0 || only.some((p) => nameMatches(name, p)));
  contributorTable(album.items, includedUploader);

  const selected = album.items.filter(
    (it) =>
      includedUploader(it.uploader) &&
      (!o.photos || it.type === 'photo') &&
      (!o.videos || it.type === 'video') &&
      (!since || it.created >= since) &&
      (!until || it.created <= until),
  );
  const missingUrl = selected.filter((it) => !it.best);

  const outDir = resolve(o.out ?? renderName('{album}', { guid: album.token, ext: '' }, { album: album.name }));
  const manifest = new Manifest(outDir, album);
  const ctx = { album: album.name, owner: album.owner, indexWidth: String(album.items.length).length, timeZone: o.tz };
  const plan = planPaths(
    selected.filter((it) => it.best),
    template,
    (it) => renderName(template, it, ctx),
    { dir: outDir, manifest, force: o.force },
  );
  const todo = plan.filter((p) => p.status === 'todo');
  const have = plan.filter((p) => p.status === 'have');
  const todoBytes = todo.reduce((s, p) => s + p.item.best.fileSize, 0);
  const shownDir = (() => {
    const rel = relative(process.cwd(), outDir);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `./${rel}` : outDir;
  })();

  console.log(`  ${c.dim('Saving to')}  ${c.bold(shownDir)}`);
  console.log(`  ${c.dim('Name     ')}  ${c.dim(template)}  ${sym.arrow}  ${todo[0]?.file ?? plan[0]?.file ?? '—'}`);
  console.log(
    `  ${c.dim('Plan     ')}  ${c.bold(todo.length)} to download ${c.dim(`(${bytes(todoBytes)})`)}` +
      (have.length ? ` ${c.dim('·')} ${have.length} already saved` : '') +
      (album.items.length - selected.length ? ` ${c.dim('·')} ${album.items.length - selected.length} filtered out` : '') +
      (missingUrl.length ? ` ${c.dim('·')} ${c.yellow(`${missingUrl.length} unavailable`)}` : ''),
  );
  console.log();

  // Record files found on disk without a manifest entry, so later runs recognise them.
  for (const p of have.filter((p) => p.adopted)) {
    manifest.record(p.item.guid, recordFor(p));
  }

  if (o['dry-run']) {
    for (const p of todo) {
      const kind = p.item.type === 'video' ? c.magenta('video') : c.blue('photo');
      console.log(`  ${c.cyan(sym.arrow)} ${kind}  ${p.file}  ${c.dim(bytes(p.item.best.fileSize))}`);
    }
    console.log(`\n  ${c.dim('Dry run — nothing was downloaded.')}\n`);
    return;
  }
  if (!todo.length) {
    if (have.some((p) => p.adopted)) manifest.save();
    console.log(`  ${c.ok(sym.ok)} ${c.green('Up to date — nothing new to download.')}\n`);
    return;
  }

  const progress = new Progress({ total: todo.length, totalBytes: todoBytes }).start();
  const controller = new AbortController();
  const active = new Set();
  const failures = [];
  let saved = 0;
  let datesFixed = 0;

  const onSigint = () => {
    controller.abort();
    progress.stop();
    cleanupParts(active);
    try {
      manifest.save();
    } catch {}
    process.stderr.write(
      `\n${ce.warn('Interrupted.')} ${saved} file${saved === 1 ? '' : 's'} saved. Run the same command again to resume.\n`,
    );
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  await pool(todo, concurrency, async (p) => {
    const dest = join(outDir, p.file);
    active.add(dest);
    progress.setCurrent(p.file);
    try {
      await downloadTo(p.item.best.url, dest, {
        signal: controller.signal,
        mtime: p.item.created,
        onBytes: (n) => progress.addBytes(n),
        beforeRename: o['no-fix-dates']
          ? undefined
          : async (part) => {
              if (await writeCaptureDate(part, p.item.ext, p.item.created, o.tz)) datesFixed++;
            },
      });
      manifest.record(p.item.guid, recordFor(p));
      manifest.save();
      saved++;
      progress.done++;
      if (o.verbose || !progress.tty) progress.log(`  ${c.green(sym.ok)} ${p.file} ${c.dim(bytes(p.item.best.fileSize))}`);
    } catch (e) {
      if (controller.signal.aborted) return;
      progress.failed++;
      failures.push({ p, e });
      progress.log(`  ${ce.red(sym.fail)} ${p.file} ${ce.dim(e.message)}`);
    } finally {
      active.delete(dest);
    }
  });

  process.removeListener('SIGINT', onSigint);
  progress.stop();
  manifest.save();

  const secs = (Date.now() - progress.started) / 1000;
  console.log(
    `  ${c.ok(sym.ok)} ${c.green(`Downloaded ${saved} file${saved === 1 ? '' : 's'}`)} ${c.dim(
      `(${bytes(progress.bytes)} in ${duration(secs)}, ${bytes(progress.bytes / Math.max(secs, 0.001))}/s)`,
    )}`,
  );
  if (datesFixed) {
    console.log(`  ${c.cyan(sym.bullet)} ${c.dim(`Wrote capture dates into ${datesFixed} file${datesFixed === 1 ? '' : 's'}`)}`);
  }
  if (failures.length) {
    console.log(`  ${c.err(sym.fail)} ${c.red(`${failures.length} failed`)} ${c.dim('— run again to retry them')}`);
  }
  console.log(`  ${c.dim('Folder:')} ${shownDir}\n`);
  if (failures.length) process.exitCode = 2;
}

// ───────────────────────────── entry ─────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return console.log(HELP);
  if (cmd === '--version' || cmd === '-V') return console.log(pkg.version);
  if (argv.includes('-h') || argv.includes('--help')) return console.log(HELP);

  switch (cmd) {
    case 'download':
    case 'dl':
      return cmdDownload(rest);
    case 'info':
      return cmdInfo(rest);
    case 'formats':
      return cmdFormats(rest);
    default:
      if (cmd.startsWith('-') || cmd.includes('icloud.com') || /^[A-Za-z0-9_-]{20,}$/.test(cmd)) return cmdDownload(argv);
      fail(`Unknown command "${cmd}".`, `Commands: download, info, formats. See ${BIN} --help`);
  }
}
