// src/data/configs.ts をデコードし、元の .conf と config ごとに一致するか検証する。
// 使い方: node scripts/verify-configs.mjs [入力ディレクトリ] [--ts <configs.ts>]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decode, parseDir } from './configs-format.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let tsPath = resolve(root, 'src/data/configs.ts');
let input = resolve(root, 'vendor/reducible-configurations/D');
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ts') tsPath = resolve(args[++i]);
  else positional.push(args[i]);
}
if (positional[0]) input = resolve(positional[0]);

const src = readFileSync(tsPath, 'utf8');
const countM = /export const CONFIG_COUNT = (\d+);/.exec(src);
const b64M = /export const CONFIGS_GZ_B64 = "([A-Za-z0-9+/=]*)";/.exec(src);
if (!countM || !b64M) throw new Error(`${tsPath}: 形式が想定と異なる`);

const decoded = decode(gunzipSync(Buffer.from(b64M[1], 'base64')));
const expected = parseDir(input);
if (Number(countM[1]) !== expected.length) throw new Error(`CONFIG_COUNT=${countM[1]} but files=${expected.length}`);
if (decoded.length !== expected.length) throw new Error(`件数不一致: decoded=${decoded.length} files=${expected.length}`);
for (let i = 0; i < expected.length; i++) {
  const a = expected[i];
  const b = decoded[i];
  const same = a.n === b.n && a.r === b.r && a.rows.length === b.rows.length &&
    a.rows.every((row, k) => row.v === b.rows[k].v && row.nb.length === b.rows[k].nb.length && row.nb.every((x, j) => x === b.rows[k].nb[j]));
  if (!same) throw new Error(`不一致: ${a.name} (index ${i})`);
}
console.log(`OK: ${decoded.length} 件すべて一致 (${input})`);
