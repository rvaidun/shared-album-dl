import { styleText, stripVTControlCharacters } from 'node:util';

function colorEnabled(stream) {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force !== 'false';
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
}

function palette(on) {
  const s = (fmt) => (text) => (on ? styleText(fmt, String(text), { validateStream: false }) : String(text));
  return {
    on,
    bold: s('bold'),
    dim: s('dim'),
    italic: s('italic'),
    red: s('red'),
    green: s('green'),
    yellow: s('yellow'),
    blue: s('blue'),
    magenta: s('magenta'),
    cyan: s('cyan'),
    gray: s('gray'),
    title: s(['bold', 'cyan']),
    ok: s(['bold', 'green']),
    err: s(['bold', 'red']),
    warn: s(['bold', 'yellow']),
  };
}

export const c = palette(colorEnabled(process.stdout));
export const ce = palette(colorEnabled(process.stderr));

export const sym = {
  ok: c.on ? '✔' : '+',
  skip: c.on ? '↷' : '-',
  fail: c.on ? '✖' : 'x',
  bullet: c.on ? '•' : '*',
  arrow: c.on ? '→' : '->',
};

export const visibleWidth = (s) => stripVTControlCharacters(String(s)).length;
export const padEnd = (s, w) => String(s) + ' '.repeat(Math.max(0, w - visibleWidth(s)));
export const padStart = (s, w) => ' '.repeat(Math.max(0, w - visibleWidth(s))) + String(s);

export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function duration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Render rows as an aligned table. `align` is an array of 'l' | 'r'. */
export function table(head, rows, align = []) {
  const widths = head.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i]))));
  const fmt = (cells) =>
    '  ' + cells.map((cell, i) => (align[i] === 'r' ? padStart(cell, widths[i]) : padEnd(cell, widths[i]))).join('   ');
  return [c.dim(fmt(head)), ...rows.map(fmt)].join('\n');
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A single-line spinner for short waits (stderr). */
export class Spinner {
  constructor(text, stream = process.stderr) {
    this.stream = stream;
    this.text = text;
    this.tty = Boolean(stream.isTTY);
    this.i = 0;
  }
  start() {
    if (!this.tty) {
      this.stream.write(`${this.text}...\n`);
      return this;
    }
    this.stream.write('\x1b[?25l');
    this.timer = setInterval(() => this.render(), 80);
    this.render();
    return this;
  }
  update(text) {
    this.text = text;
    if (this.tty) this.render();
  }
  render() {
    this.stream.write(`\r\x1b[K${ce.cyan(FRAMES[this.i++ % FRAMES.length])} ${this.text}`);
  }
  stop(finalLine) {
    if (this.tty) {
      clearInterval(this.timer);
      this.stream.write('\r\x1b[K\x1b[?25h');
    }
    if (finalLine) this.stream.write(finalLine + '\n');
  }
}

/** Multi-file progress bar: counts, bytes, speed and ETA (stderr). */
export class Progress {
  constructor({ total, totalBytes, stream = process.stderr }) {
    Object.assign(this, { total, totalBytes, stream });
    this.tty = Boolean(stream.isTTY);
    this.done = 0;
    this.failed = 0;
    this.bytes = 0;
    this.current = '';
    this.i = 0;
    this.started = Date.now();
  }
  start() {
    if (this.tty) {
      this.stream.write('\x1b[?25l');
      this.timer = setInterval(() => this.render(), 100);
    }
    return this;
  }
  addBytes(n) {
    this.bytes += n;
  }
  setCurrent(name) {
    this.current = name;
  }
  /** Print a permanent line above the bar. */
  log(line) {
    if (this.tty) this.stream.write('\r\x1b[K');
    this.stream.write(line + '\n');
    if (this.tty) this.render();
  }
  render() {
    const cols = this.stream.columns || 80;
    const elapsed = (Date.now() - this.started) / 1000;
    const speed = elapsed > 0.5 ? this.bytes / elapsed : 0;
    const eta = speed > 0 ? (this.totalBytes - this.bytes) / speed : NaN;
    const ratio = this.totalBytes > 0 ? Math.min(1, this.bytes / this.totalBytes) : this.done / (this.total || 1);
    const barW = Math.max(10, Math.min(30, cols - 70));
    const fill = Math.round(ratio * barW);
    const bar = ce.cyan('█'.repeat(fill)) + ce.dim('░'.repeat(barW - fill));
    const count = `${ce.bold(String(this.done + this.failed).padStart(String(this.total).length))}/${this.total}`;
    const stats = `${bytes(this.bytes)} ${ce.dim('·')} ${bytes(speed)}/s ${ce.dim('·')} ETA ${duration(eta)}`;
    let line = `${ce.cyan(FRAMES[this.i++ % FRAMES.length])} ${bar} ${String(Math.round(ratio * 100)).padStart(3)}%  ${count}  ${stats}`;
    const room = cols - visibleWidth(line) - 3;
    if (room > 8 && this.current) {
      const name = this.current.length > room ? '…' + this.current.slice(-(room - 1)) : this.current;
      line += '  ' + ce.dim(name);
    }
    this.stream.write('\r\x1b[K' + line);
  }
  stop() {
    if (this.tty) {
      clearInterval(this.timer);
      this.stream.write('\r\x1b[K\x1b[?25h');
    }
  }
}
