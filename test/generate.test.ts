import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateMap, hilbertIndex, mulberry32 } from '../src/map/generate';
import type { GeneratedMap } from '../src/map/generate';
import type { Distribution, GenerateParams } from '../src/protocol';

function params(over: Partial<GenerateParams> = {}): GenerateParams {
  return { numCells: 5000, distribution: 'uniform', cellsPerRegion: 1, seed: 12345, aspect: 1.6, ...over };
}

/** 配列の形と三角形分割・CSR 隣接の整合性を調べる */
function checkStructure(m: GeneratedMap): void {
  const n = m.params.numCells;
  assert.equal(m.tri.numCells, n);
  assert.equal(m.points.length, 2 * n);
  assert.equal(m.labels.length, n);
  assert.equal(m.nbrOffsets.length, n + 1);
  assert.equal(m.nbrOffsets[0], 0);
  assert.equal(m.nbrOffsets[n], m.nbrs.length);
  const { triangles, halfedges } = m.tri;
  assert.ok(triangles instanceof Uint32Array);
  assert.ok(halfedges instanceof Int32Array);
  assert.equal(triangles.length % 3, 0);
  assert.equal(halfedges.length, triangles.length);

  // 座標は地図の矩形内、かつすべて異なる
  const aspect = m.params.aspect;
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const x = m.points[2 * i];
    const y = m.points[2 * i + 1];
    assert.ok(x >= 0 && x <= aspect && y >= 0 && y <= 1, `点 ${i} が範囲外: ${x},${y}`);
    const key = `${x},${y}`;
    assert.ok(!seen.has(key), `重複点 ${i}`);
    seen.add(key);
  }

  // halfedges は対合で、向きが逆の同じ辺を指す
  const next = (e: number) => (e % 3 === 2 ? e - 2 : e + 1);
  for (let e = 0; e < halfedges.length; e++) {
    assert.ok(triangles[e] < n);
    const h = halfedges[e];
    if (h === -1) continue;
    assert.equal(halfedges[h], e);
    assert.equal(triangles[h], triangles[next(e)]);
    assert.equal(triangles[next(h)], triangles[e]);
  }

  // CSR: 自己ループなし・重複なし・対称・全セルが次数 >= 2
  const edgeSet = new Set<number>();
  for (let v = 0; v < n; v++) {
    const a = m.nbrOffsets[v];
    const b = m.nbrOffsets[v + 1];
    assert.ok(b - a >= 2, `セル ${v} の次数が ${b - a}`);
    const local = new Set<number>();
    for (let p = a; p < b; p++) {
      const w = m.nbrs[p];
      assert.ok(w < n && w !== v);
      assert.ok(!local.has(w), `セル ${v} の隣接に重複 ${w}`);
      local.add(w);
      edgeSet.add(v * n + w);
    }
  }
  for (const k of edgeSet) {
    const v = Math.floor(k / n);
    const w = k % n;
    assert.ok(edgeSet.has(w * n + v), `隣接が非対称 ${v}-${w}`);
  }
  // 三角形分割の辺と CSR の辺が一致する
  for (let e = 0; e < triangles.length; e++) {
    assert.ok(edgeSet.has(triangles[e] * n + triangles[next(e)]));
  }
  assert.equal(edgeSet.size, m.nbrs.length);
}

/** 各ラベルのセルが隣接で連結であることと、ラベルが 0..k-1 を漏れなく使うことを調べる */
function checkRegions(m: GeneratedMap, expectedRegions: number): void {
  const n = m.params.numCells;
  const { labels, nbrOffsets, nbrs } = m;
  let maxLab = -1;
  for (let i = 0; i < n; i++) {
    assert.ok(labels[i] >= 0, `セル ${i} のラベルが ${labels[i]}`);
    if (labels[i] > maxLab) maxLab = labels[i];
  }
  assert.equal(maxLab + 1, expectedRegions);
  const visited = new Uint8Array(n);
  const labelSeen = new Uint8Array(expectedRegions);
  const queue = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    const lab = labels[s];
    assert.equal(labelSeen[lab], 0, `ラベル ${lab} の領域が連結でない`);
    labelSeen[lab] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    visited[s] = 1;
    while (head < tail) {
      const c = queue[head++];
      for (let p = nbrOffsets[c]; p < nbrOffsets[c + 1]; p++) {
        const d = nbrs[p];
        if (!visited[d] && labels[d] === lab) {
          visited[d] = 1;
          queue[tail++] = d;
        }
      }
    }
  }
  for (let l = 0; l < expectedRegions; l++) assert.equal(labelSeen[l], 1, `ラベル ${l} が使われていない`);
}

test('mulberry32 は決定的で [0,1) を返す', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('hilbertIndex は 2^16 格子上の全単射(小さな部分格子で確認)', () => {
  // 左下 256×256 の部分格子は Hilbert 曲線の連続した区間 [0, 65536) に写る
  const seen = new Uint8Array(65536);
  for (let x = 0; x < 256; x++) {
    for (let y = 0; y < 256; y++) {
      const d = hilbertIndex(x, y);
      assert.ok(d < 65536);
      assert.equal(seen[d], 0);
      seen[d] = 1;
    }
  }
  // 曲線上で隣り合う位置は格子上でも隣り合う
  const pos = new Int32Array(2 * 65536);
  for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y++) {
    const d = hilbertIndex(x, y);
    pos[2 * d] = x;
    pos[2 * d + 1] = y;
  }
  for (let d = 1; d < 65536; d++) {
    assert.equal(Math.abs(pos[2 * d] - pos[2 * d - 2]) + Math.abs(pos[2 * d + 1] - pos[2 * d - 1]), 1);
  }
  assert.ok(hilbertIndex(65535, 0) <= 0xffffffff);
});

test('同じシードなら同じ地図、違うシードなら違う地図', () => {
  for (const distribution of ['uniform', 'jitter', 'hex'] as Distribution[]) {
    const p = params({ distribution, cellsPerRegion: 8 });
    const a = generateMap(p);
    const b = generateMap(p);
    assert.deepEqual(a.points, b.points);
    assert.deepEqual(a.labels, b.labels);
    assert.deepEqual(a.tri.triangles, b.tri.triangles);
    assert.deepEqual(a.nbrs, b.nbrs);
    const c = generateMap({ ...p, seed: p.seed + 1 });
    assert.notDeepEqual(a.points, c.points);
  }
});

test('3 種類の分布で構造が正しい', () => {
  for (const distribution of ['uniform', 'jitter', 'hex'] as Distribution[]) {
    for (const aspect of [1.6, 0.7]) {
      const m = generateMap(params({ distribution, aspect, numCells: 3000 }));
      checkStructure(m);
      const n = m.params.numCells;
      if (distribution === 'uniform') assert.equal(n, 3000);
      else assert.ok(Math.abs(n - 3000) / 3000 < 0.05, `${distribution}: 点数 ${n}`);
      assert.equal(m.params.distribution, distribution);
      assert.equal(m.params.aspect, aspect);
    }
  }
});

test('ほぼ正六角格子では内部の頂点はほぼすべて次数 6', () => {
  const m = generateMap(params({ distribution: 'hex', numCells: 20000 }));
  const n = m.params.numCells;
  // 凸包付近はほぼ一直線の点列なので細長い三角形ができる。境界から格子間隔の 3 倍以上内側だけを見る
  const s = Math.sqrt(m.params.aspect / n);
  const margin = 3 * s;
  const onHull = new Uint8Array(n);
  const { triangles, halfedges } = m.tri;
  for (let e = 0; e < halfedges.length; e++) {
    if (halfedges[e] === -1) {
      onHull[triangles[e]] = 1;
      onHull[triangles[e % 3 === 2 ? e - 2 : e + 1]] = 1;
    }
  }
  let interior = 0;
  let deg6 = 0;
  for (let v = 0; v < n; v++) {
    if (onHull[v]) continue;
    const x = m.points[2 * v];
    const y = m.points[2 * v + 1];
    if (Math.min(x, m.params.aspect - x, y, 1 - y) < margin) continue;
    interior++;
    if (m.nbrOffsets[v + 1] - m.nbrOffsets[v] === 6) deg6++;
  }
  assert.ok(interior > n * 0.9);
  assert.ok(deg6 / interior > 0.999, `次数 6 の割合 ${deg6 / interior}`);
});

test('点は空間的に並んでいる(隣接セルの番号が近い)', () => {
  const m = generateMap(params({ numCells: 50000 }));
  const n = m.params.numCells;
  const gaps: number[] = [];
  for (let v = 0; v < n; v += 7) {
    for (let p = m.nbrOffsets[v]; p < m.nbrOffsets[v + 1]; p++) gaps.push(Math.abs(m.nbrs[p] - v));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  assert.ok(median < n / 200, `隣接セルの番号差の中央値 ${median}`);
});

test('領域ラベル: 範囲と連結性', () => {
  for (const distribution of ['uniform', 'jitter', 'hex'] as Distribution[]) {
    for (const cpr of [1, 2, 4, 16, 64]) {
      const m = generateMap(params({ distribution, cellsPerRegion: cpr, numCells: 4000, seed: cpr }));
      const n = m.params.numCells;
      const k = cpr <= 1 ? n : Math.round(n / cpr);
      checkRegions(m, k);
      if (cpr <= 1) for (let i = 0; i < n; i++) assert.equal(m.labels[i], i);
    }
  }
});

test('小さすぎる指定でも動く', () => {
  const m = generateMap(params({ numCells: 1 }));
  checkStructure(m);
  checkRegions(m, m.params.numCells);
});

test('20 万セルのスモークテスト', () => {
  for (const distribution of ['uniform', 'jitter', 'hex'] as Distribution[]) {
    const t0 = performance.now();
    const m = generateMap(params({ numCells: 200_000, distribution, cellsPerRegion: 8, seed: 7 }));
    const ms = performance.now() - t0;
    console.log(`  generateMap 200k ${distribution}: ${ms.toFixed(0)} ms (セル数 ${m.params.numCells})`);
    const n = m.params.numCells;
    assert.ok(Math.abs(n - 200_000) < 2000);
    assert.equal(m.nbrOffsets.length, n + 1);
    // Euler: 平面三角形分割の辺数 = 3n - 3 - (凸包の頂点数)
    let hullEdges = 0;
    for (let e = 0; e < m.tri.halfedges.length; e++) if (m.tri.halfedges[e] === -1) hullEdges++;
    assert.equal(m.nbrs.length / 2, 3 * n - 3 - hullEdges);
    checkRegions(m, Math.round(n / 8));
  }
});
