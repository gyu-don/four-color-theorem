// 単一の自己完結 HTML (dist/index.html) をビルドする。
// 使い方: node scripts/build.mjs [--no-minify] [--watch] [--src <dir>] [--out <dir>]
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  if (i + 1 >= argv.length) throw new Error(`${name} には値が必要です`);
  return argv[i + 1];
};
const minify = !flag('--no-minify');
const watchMode = flag('--watch');
const srcDir = resolve(process.cwd(), opt('--src', resolve(root, 'src')));
const outDir = resolve(process.cwd(), opt('--out', resolve(root, 'dist')));

const CSS_LINE = '<link rel="stylesheet" href="style.css">';
const JS_LINE = '<script type="module" src="main.ts"></script>';

async function bundle(entry, plugins = []) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins,
  });
  if (result.outputFiles.length !== 1) throw new Error(`${entry}: 出力が 1 ファイルではない`);
  return result.outputFiles[0].text;
}

/** `</script`(大小文字無視)と `<!--` をインライン <script> 内で安全な形にする */
function escapeForInlineScript(js) {
  return js.replace(/<\/script/gi, (m) => '<\\/' + m.slice(2)).replace(/<!--/g, '<\\!--');
}

function replaceLine(html, line, replacement, label) {
  const lines = html.split('\n');
  const idx = lines.findIndex((l) => l.trim() === line);
  if (idx < 0) throw new Error(`index.html に ${label} 行がありません: ${line}`);
  // 関数形式のリプレーサ: バンドル内の `$&` 等を解釈させない
  lines[idx] = lines[idx].replace(line, () => replacement);
  return lines.join('\n');
}

async function buildOnce() {
  const t0 = performance.now();
  const workerJs = await bundle(resolve(srcDir, 'worker.ts'));
  const workerPlugin = {
    name: 'virtual-worker-source',
    setup(b) {
      b.onResolve({ filter: /^virtual:worker-source$/ }, () => ({ path: 'worker-source', namespace: 'virtual-worker' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual-worker' }, () => ({
        contents: `export default ${JSON.stringify(workerJs)};`,
        loader: 'js',
      }));
    },
  };
  const mainJs = escapeForInlineScript(await bundle(resolve(srcDir, 'main.ts'), [workerPlugin]));
  const css = readFileSync(resolve(srcDir, 'style.css'), 'utf8');
  let html = readFileSync(resolve(srcDir, 'index.html'), 'utf8');
  html = replaceLine(html, CSS_LINE, `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`, 'stylesheet');
  html = replaceLine(html, JS_LINE, `<script>${mainJs}</script>`, 'script');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, 'index.html');
  writeFileSync(outFile, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`${outFile}: ${kb} KB (${minify ? 'minify' : 'no-minify'}, ${Math.round(performance.now() - t0)} ms)`);
}

async function run() {
  try {
    await buildOnce();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    if (!watchMode) process.exit(1);
  }
}

await run();
if (watchMode) {
  console.log(`watching ${srcDir} ...`);
  let timer;
  watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 100);
  });
}
