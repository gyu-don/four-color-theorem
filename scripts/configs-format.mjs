// pack-configs.mjs と verify-configs.mjs が共有するパーサ/エンコーダ。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** .conf のテキストを検証しつつ { n, r, rows } にパースする。違反時は filename 付きで throw。 */
export function parseConf(text, filename) {
  const fail = (msg) => {
    throw new Error(`${filename}: ${msg}`);
  };
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) fail('空ファイル');
  const head = lines[0].trim().split(/\s+/).map(Number);
  if (head.length !== 2 || head.some((x) => !Number.isInteger(x))) fail(`ヘッダ行が不正: "${lines[0]}"`);
  const [n, r] = head;
  if (n > 255) fail(`N=${n} が 255 を超える`);
  if (r < 0 || r > n) fail(`R=${r} が不正 (N=${n})`);
  if (lines.length - 1 !== n - r) fail(`行数が N-R=${n - r} と一致しない (実際 ${lines.length - 1})`);
  const rows = [];
  for (let k = 0; k < n - r; k++) {
    const raw = lines[k + 1];
    const t = raw.trim().split(/\s+/).map(Number);
    if (t.some((x) => !Number.isInteger(x))) fail(`非整数トークン: "${raw}"`);
    if (t[0] !== r + k + 1) fail(`${k + 1} 番目の頂点行の添字が ${t[0]} (期待 ${r + k + 1})`);
    const deg = t[1];
    if (deg === undefined || deg < 0 || deg > 255) fail(`deg が不正: "${raw}"`);
    if (t.length !== 2 + deg) fail(`近傍数が deg=${deg} と一致しない: "${raw}"`);
    const nb = t.slice(2);
    for (const v of nb) if (v < 1 || v > n) fail(`近傍添字 ${v} が 1..${n} の範囲外`);
    rows.push({ v: t[0], nb });
  }
  return { n, r, rows };
}

export function listConfFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.conf'))
    .sort();
}

export function parseDir(dir) {
  return listConfFiles(dir).map((f) => ({ name: f, ...parseConf(readFileSync(join(dir, f), 'utf8'), f) }));
}

/** バイナリ: u16LE count, 各 config: N, R, 各内部頂点: deg, nb... */
export function encode(configs) {
  if (configs.length > 0xffff) throw new Error('config 数が u16 を超える');
  const bytes = [configs.length & 0xff, configs.length >> 8];
  for (const c of configs) {
    bytes.push(c.n, c.r);
    for (const row of c.rows) bytes.push(row.nb.length, ...row.nb);
  }
  return Buffer.from(bytes);
}

/** encode の逆。{ n, r, rows:[{v, nb}] }[] を返す。 */
export function decode(buf) {
  let p = 0;
  const count = buf[p] | (buf[p + 1] << 8);
  p += 2;
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = buf[p++];
    const r = buf[p++];
    const rows = [];
    for (let k = 0; k < n - r; k++) {
      const deg = buf[p++];
      rows.push({ v: r + k + 1, nb: Array.from(buf.subarray(p, p + deg)) });
      p += deg;
    }
    out.push({ n, r, rows });
  }
  if (p !== buf.length) throw new Error(`デコード後に余剰バイト ${buf.length - p}`);
  return out;
}
