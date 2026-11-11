// vendor/reducible-configurations/D/*.conf を src/data/configs.ts にパックする。
// 使い方: node scripts/pack-configs.mjs [入力ディレクトリ] [--out <出力ファイル>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, constants } from 'node:zlib';
import { encode, parseDir } from './configs-format.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let out = resolve(root, 'src/data/configs.ts');
let input = resolve(root, 'vendor/reducible-configurations/D');
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i]);
  else positional.push(args[i]);
}
if (positional[0]) input = resolve(positional[0]);

const configs = parseDir(input);
const raw = encode(configs);
const gz = gzipSync(raw, { level: 9 });
const b64 = gz.toString('base64');

const ts =
  `// 自動生成ファイル: scripts/pack-configs.mjs が生成。手で編集しないこと。\n` +
  `// 出典: https://github.com/near-linear-4ct/reducible-configurations (MIT License, Copyright (c) 2026 Yuta Inoue)\n` +
  `export const CONFIG_COUNT = ${configs.length};\n` +
  `/** gzip 圧縮したバイナリを base64 にしたもの */\n` +
  `export const CONFIGS_GZ_B64 = "${b64}";\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ts);
console.log(`configs: ${configs.length}  raw: ${raw.length} B  gzip: ${gz.length} B  base64: ${b64.length} B  -> ${out}`);
