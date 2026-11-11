import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateMap, mulberry32 } from '../src/map/generate';
import type { GeneratedMap } from '../src/map/generate';
import { applyPermutation, bestPermutation } from '../src/ui/colorMatch';
import { CellWalker, EditHistory, maxLabel, splitSide } from '../src/ui/edit';
import { computeCellBuffer, computeSafeRadii, nearestSite, nearestSiteBrute } from '../src/ui/nearest';
import type { SiteGraph } from '../src/ui/nearest';
import { packColor } from '../src/ui/palette';

function smallMap(n: number, distribution: 'uniform' | 'jitter' | 'hex' = 'uniform', cpr = 1, seed = 9): GeneratedMap {
  return generateMap({ numCells: n, distribution, cellsPerRegion: cpr, seed, aspect: 1.5 });
}

function graph(m: GeneratedMap): SiteGraph {
  return { numCells: m.params.numCells, points: m.points, nbrOffsets: m.nbrOffsets, nbrs: m.nbrs };
}

function dist2(g: SiteGraph, c: number, x: number, y: number): number {
  const dx = g.points[2 * c] - x;
  const dy = g.points[2 * c + 1] - y;
  return dx * dx + dy * dy;
}

test('貪欲歩行の最近傍は総当たりと一致する(地図の外の点も含む)', () => {
  const rand = mulberry32(1);
  for (const dist of ['uniform', 'jitter', 'hex'] as const) {
    const m = smallMap(2000, dist);
    const g = graph(m);
    for (let k = 0; k < 3000; k++) {
      const x = -0.3 + rand() * 2.1;
      const y = -0.3 + rand() * 1.6;
      const start = Math.floor(rand() * g.numCells);
      const a = nearestSite(g, start, x, y);
      const b = nearestSiteBrute(g, x, y);
      // 等距離のときは番号が違ってもよい
      assert.equal(dist2(g, a, x, y), dist2(g, b, x, y));
    }
  }
});

test('ID バッファは各画素の中心の最近傍サイト、地図の外は -1', () => {
  for (const dist of ['uniform', 'hex'] as const) {
    const m = smallMap(800, dist);
    const g = graph(m);
    const safe = computeSafeRadii(g);
    // [幅, 高さ, 原点 x, 原点 y, 画素の大きさ]: 全体表示・拡大表示・端の半端なブロック・1 画素幅
    const cases: [number, number, number, number, number][] = [
      [97, 61, -0.1, -0.05, 1.75 / 97],
      [120, 80, 0.3, 0.2, 0.004],
      [64, 41, 1.3, 0.85, 0.01],
      // 以下 2 つはセルが大きいのでブロック法の経路(2 つ目は地図の角をまたぐ)
      [101, 67, 0.45, 0.35, 0.0012],
      [90, 70, 1.45, 0.95, 0.0015],
      [1, 30, 0.5, 0.1, 0.02],
      [30, 1, 0.1, 0.5, 0.02],
    ];
    for (const [W, H, originX, originY, pixelSize] of cases) {
      for (const sr of [null, safe]) {
        const spec = { width: W, height: H, originX, originY, pixelSize, aspect: 1.5, step: 1 };
        const out = new Int32Array(W * H).fill(-7);
        computeCellBuffer(g, out, spec, 0, sr);
        for (let j = 0; j < H; j++) {
          for (let i = 0; i < W; i++) {
            const x = originX + (i + 0.5) * pixelSize;
            const y = originY + (j + 0.5) * pixelSize;
            const c = out[j * W + i];
            if (x < 0 || x > 1.5 || y < 0 || y > 1) {
              assert.equal(c, -1, `画素 ${i},${j} は地図の外`);
            } else {
              assert.ok(c >= 0, `画素 ${i},${j} が未設定`);
              assert.equal(dist2(g, c, x, y), dist2(g, nearestSiteBrute(g, x, y), x, y));
            }
          }
        }
      }
    }
  }
});

test('内接円の半径: その内側の点の最近傍は必ずそのサイト', () => {
  const rand = mulberry32(11);
  const m = smallMap(1500, 'jitter');
  const g = graph(m);
  const safe = computeSafeRadii(g);
  for (let k = 0; k < 3000; k++) {
    const c = Math.floor(rand() * g.numCells);
    const r = Math.sqrt(safe[c]) * Math.sqrt(rand());
    const a = rand() * 2 * Math.PI;
    const x = g.points[2 * c] + r * Math.cos(a);
    const y = g.points[2 * c + 1] + r * Math.sin(a);
    assert.ok(dist2(g, c, x, y) <= dist2(g, nearestSiteBrute(g, x, y), x, y) + 1e-15);
  }
});

test('粗い ID バッファ (step=3) はブロック中心の最近傍で埋まる', () => {
  const m = smallMap(800, 'jitter');
  const g = graph(m);
  const W = 50;
  const H = 34;
  const step = 3;
  const spec = { width: W, height: H, originX: 0.2, originY: 0.1, pixelSize: 1 / W, aspect: 1.5, step };
  const out = new Int32Array(W * H).fill(-7);
  computeCellBuffer(g, out, spec, 5);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const bi = i - (i % step);
      const bj = j - (j % step);
      const x = spec.originX + (bi + step / 2) * spec.pixelSize;
      const y = spec.originY + (bj + step / 2) * spec.pixelSize;
      const c = out[j * W + i];
      assert.ok(c >= 0, `画素 ${i},${j} が未設定`);
      assert.equal(dist2(g, c, x, y), dist2(g, nearestSiteBrute(g, x, y), x, y));
    }
  }
});

test('ブラシ: 円内のサイトを持つセルを漏れなく集める', () => {
  const rand = mulberry32(2);
  const m = smallMap(3000, 'uniform');
  const g = graph(m);
  const w = new CellWalker(g);
  for (let k = 0; k < 300; k++) {
    const cx = rand() * 1.5;
    const cy = rand();
    const r = rand() * 0.15;
    const start = nearestSite(g, 0, cx, cy);
    const got = new Set(w.brush(start, cx, cy, r));
    const want = new Set<number>([start]);
    for (let c = 0; c < g.numCells; c++) if (dist2(g, c, cx, cy) <= r * r) want.add(c);
    assert.deepEqual([...got].sort((a, b) => a - b), [...want].sort((a, b) => a - b));
  }
});

/** 参照実装: 同ラベルの連結成分 */
function refComponent(m: GeneratedMap, labels: Int32Array, start: number): number[] {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const c = stack.pop()!;
    for (let p = m.nbrOffsets[c]; p < m.nbrOffsets[c + 1]; p++) {
      const d = m.nbrs[p];
      if (!seen.has(d) && labels[d] === labels[start]) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

test('連結成分の塗りつぶし探索(同じラベルでも離れていれば別成分)', () => {
  const rand = mulberry32(3);
  const m = smallMap(3000, 'uniform', 16);
  const labels = m.labels.slice();
  // ラベルを 3 種類に潰して、同ラベルで非連結な部分を作る
  for (let i = 0; i < labels.length; i++) labels[i] = labels[i] % 3;
  const w = new CellWalker(graph(m));
  for (let k = 0; k < 100; k++) {
    const s = Math.floor(rand() * labels.length);
    const got = [...w.component(labels, s)].sort((a, b) => a - b);
    assert.deepEqual(got, refComponent(m, labels, s));
  }
});

test('分割: 直線の両側に分け、片側が空なら null', () => {
  const m = smallMap(2000, 'uniform', 64);
  const w = new CellWalker(graph(m));
  const comp = w.component(m.labels, 100).slice();
  const qx = m.points[200];
  const qy = m.points[201];
  const side = splitSide(m.points, comp, qx, qy, 0.7);
  assert.ok(side !== null);
  const inSide = new Set(side);
  const nx = -Math.sin(0.7);
  const ny = Math.cos(0.7);
  for (const c of comp) {
    const s = (m.points[2 * c] - qx) * nx + (m.points[2 * c + 1] - qy) * ny;
    assert.equal(inSide.has(c), s > 0);
  }
  assert.ok(side.length > 0 && side.length < comp.length);
  // 領域の外を通る直線
  assert.equal(splitSide(m.points, comp, 0, -10, 0), null);
  assert.equal(splitSide(m.points, new Uint32Array([5]), 0, 0, 1), null);
});

test('元に戻す/やり直す: 差分だけを記録し、往復で元に戻る', () => {
  const rand = mulberry32(4);
  const n = 500;
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i % 7;
  const original = labels.slice();
  const h = new EditHistory(labels, n);
  const snapshots: Int32Array[] = [labels.slice()];
  for (let s = 0; s < 20; s++) {
    h.begin();
    for (let k = 0; k < 40; k++) {
      const c = Math.floor(rand() * n);
      h.set(c, Math.floor(rand() * 10));
    }
    if (h.commit()) snapshots.push(labels.slice());
  }
  // 変化のないストロークは履歴に積まない
  h.begin();
  h.set(3, labels[3]);
  assert.equal(h.commit(), false);
  h.begin();
  const old = labels[4];
  h.set(4, old + 100);
  h.set(4, old);
  assert.equal(h.commit(), false);

  const final = labels.slice();
  for (let k = snapshots.length - 1; k > 0; k--) {
    assert.deepEqual(labels, snapshots[k]);
    const cells = h.undo();
    assert.ok(cells !== null);
    // 差分には実際に変わったセルだけが入っている
    for (const c of cells) assert.notEqual(snapshots[k][c], snapshots[k - 1][c]);
  }
  assert.deepEqual(labels, original);
  assert.equal(h.undo(), null);
  assert.equal(h.canUndo, false);
  while (h.redo() !== null);
  assert.deepEqual(labels, final);
  // 新しい編集でやり直し履歴は消える
  h.undo();
  h.begin();
  h.set(0, 999);
  h.commit();
  assert.equal(h.canRedo, false);
  assert.equal(maxLabel(labels), 999);
});

test('色の置換: 24 通りの総当たりと同じ最大一致数', () => {
  const rand = mulberry32(5);
  const perms: number[][] = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) {
    if (new Set([a, b, c, d]).size === 4) perms.push([a, b, c, d]);
  }
  for (let t = 0; t < 50; t++) {
    const n = 1 + Math.floor(rand() * 300);
    const prev = new Uint8Array(n);
    const next = new Uint8Array(n);
    const hidden = perms[Math.floor(rand() * 24)];
    for (let i = 0; i < n; i++) {
      prev[i] = Math.floor(rand() * 4);
      // 大半は隠れた置換で対応し、一部はノイズ
      next[i] = rand() < 0.7 ? hidden.indexOf(prev[i]) : Math.floor(rand() * 4);
    }
    const score = (p: ArrayLike<number>) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (p[next[i]] === prev[i]) s++;
      return s;
    };
    const best = Math.max(...perms.map(score));
    const p = bestPermutation(prev, next);
    assert.equal(new Set(p).size, 4);
    assert.equal(score(p), best);
    const c = next.slice();
    applyPermutation(c, p);
    let same = 0;
    for (let i = 0; i < n; i++) if (c[i] === prev[i]) same++;
    assert.equal(same, best);
  }
  // 長さが違えば恒等置換
  assert.deepEqual([...bestPermutation(new Uint8Array(3), new Uint8Array(4))], [0, 1, 2, 3]);
});

test('packColor はリトルエンディアンの RGBA バイト列になる', () => {
  const v = new Uint32Array([packColor('#123456')]);
  assert.deepEqual([...new Uint8Array(v.buffer)], [0x12, 0x34, 0x56, 0xff]);
});

test('パン時に ID バッファをずらして再利用しても、全体を計算し直した結果と一致する', async () => {
  // MapView が使う最小限の DOM をスタブする
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { documentElement: {} };
  g.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  g.requestAnimationFrame ??= () => 1;
  (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio = 1;
  const { MapView } = await import('../src/ui/view');
  const ctx = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
  };
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 230, height: 170 }), width: 0, height: 0, style: {} };
  const view = new MapView(canvas as unknown as HTMLCanvasElement);
  const m = smallMap(3000, 'jitter');
  const map = { ...graph(m), aspect: m.params.aspect, labels: m.labels };
  view.setMap(map);
  const v = view as unknown as { render(): void; cellAt: Int32Array; idsValid: boolean };
  v.render();
  view.zoomAt(100, 80, 6);
  v.render();
  v.render(); // 粗い計算の後の再計算(必要なら)
  view.invalidateIds(false);
  v.render();
  const rand = mulberry32(21);
  let shifted = 0;
  for (let k = 0; k < 40; k++) {
    view.panBy((rand() - 0.5) * 30, (rand() - 0.5) * 30);
    const before = (view as unknown as { idsTx: number }).idsTx;
    v.render();
    if ((view as unknown as { idsTx: number }).idsTx !== before) shifted++;
    const ref = new Int32Array(view.W * view.H);
    computeCellBuffer(
      map,
      ref,
      {
        width: view.W,
        height: view.H,
        originX: -view.tx / view.scale,
        originY: -view.ty / view.scale,
        pixelSize: 1 / (view.scale * view.bufScale),
        aspect: map.aspect,
        step: 1,
      },
      0,
    );
    for (let p = 0; p < ref.length; p++) {
      const a = v.cellAt[p];
      const b = ref[p];
      if (a === b) continue;
      // 等距離の場合だけ番号の違いを許す
      assert.ok(a >= 0 && b >= 0, `画素 ${p}: ${a} vs ${b}`);
      const i = p % view.W;
      const j = Math.floor(p / view.W);
      const px = 1 / (view.scale * view.bufScale);
      const x = -view.tx / view.scale + (i + 0.5) * px;
      const y = -view.ty / view.scale + (j + 0.5) * px;
      assert.equal(dist2(map, a, x, y), dist2(map, b, x, y));
    }
  }
  assert.ok(shifted > 20, `ずらして再利用した回数 ${shifted}`);
});
