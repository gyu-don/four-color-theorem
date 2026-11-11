import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { FourColorSolver, verifyColoring, type RotationSystem } from '../src/core/index';
import { Tri } from '../src/core/graph';
import { generateMap } from '../src/map/generate';
import { buildRegionGraph } from '../src/map/regionGraph';
import type { Distribution } from '../src/protocol';

/** rotation system のオイラー標数 V - E + F(平面埋め込みなら 2)と単純性を調べる */
function checkPlaneGraph(g: RotationSystem): void {
  const { n, offsets, neighbors } = g;
  const slots = neighbors.length;
  const owner = new Int32Array(slots);
  const pos = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const seen = new Set<number>();
    for (let s = offsets[v]; s < offsets[v + 1]; s++) {
      const w = neighbors[s];
      assert.notEqual(w, v, 'loop');
      assert.ok(!seen.has(w), `parallel edge ${v}-${w}`);
      seen.add(w);
      owner[s] = v;
      pos.set(v * n + w, s);
    }
  }
  const seen = new Uint8Array(slots);
  let faces = 0;
  for (let s0 = 0; s0 < slots; s0++) {
    if (seen[s0]) continue;
    faces++;
    let s = s0;
    do {
      seen[s] = 1;
      const v = owner[s], w = neighbors[s];
      const back = pos.get(w * n + v);
      assert.ok(back !== undefined, `asymmetric edge ${v}-${w}`);
      // (v→w) の次は w のまわりで (w→v) の 1 つ前
      s = back > offsets[w] ? back - 1 : offsets[w + 1] - 1;
    } while (s !== s0);
  }
  assert.equal(n - slots / 2 + faces, 2, 'Euler characteristic (graph must be connected and plane)');
}

let solver: FourColorSolver;
before(async () => {
  solver = await FourColorSolver.create();
});

function solveMap(
  numCells: number,
  distribution: Distribution,
  cellsPerRegion: number,
  seed: number,
  kempeMode: 'greedy' | 'random' = 'greedy',
  identifyDegree4 = true,
) {
  const m = generateMap({ numCells, distribution, cellsPerRegion, seed, aspect: 1.5 });
  const rg = buildRegionGraph(m.tri, m.labels);
  checkPlaneGraph(rg.graph);
  const res = solver.solve(rg.graph, { verify: true, kempeMode, seed, identifyDegree4 });
  verifyColoring(rg.graph, res.colors);
  // セル単位でも確認: 違う領域に属する隣接セルは違う色
  for (let c = 0; c < m.tri.numCells; c++) {
    for (let i = m.nbrOffsets[c]; i < m.nbrOffsets[c + 1]; i++) {
      const d = m.nbrs[i];
      if (rg.cellVertex[c] !== rg.cellVertex[d]) {
        assert.notEqual(res.colors[rg.cellVertex[c]], res.colors[rg.cellVertex[d]]);
      }
    }
  }
  return { m, rg, res };
}

describe('ライブラリ', () => {
  test('D の 8200 個 + 単独頂点 2 個を読み込む', () => {
    assert.equal(solver.configCount, 8202);
  });
});

describe('領域グラフ', () => {
  for (const cpr of [1, 2, 4, 16, 64]) {
    test(`1 領域 ${cpr} セル: 単純な平面グラフになる`, () => {
      for (const seed of [1, 7, 42]) {
        const m = generateMap({ numCells: 3000, distribution: 'uniform', cellsPerRegion: cpr, seed, aspect: 1.5 });
        const rg = buildRegionGraph(m.tri, m.labels);
        checkPlaneGraph(rg.graph);
        assert.equal(rg.seaVertex, rg.graph.n - 1);
      }
    });
  }

  test('穴のある領域・飛び地・同ラベルの非連結成分', () => {
    const m = generateMap({ numCells: 4000, distribution: 'jitter', cellsPerRegion: 1, seed: 3, aspect: 1 });
    const N = m.tri.numCells;
    const labels = new Int32Array(N);
    for (let c = 0; c < N; c++) {
      const x = m.points[2 * c] - 0.5, y = m.points[2 * c + 1] - 0.5;
      const r = Math.hypot(x, y);
      // 同心円の輪(穴あき領域)と、その中の小領域、ラベル 0 は非連結
      labels[c] = r < 0.08 ? 1 : r < 0.2 ? 2 : r < 0.24 ? (c % 3 === 0 ? 100 + c : 3) : r < 0.4 ? 4 : 0;
    }
    const rg = buildRegionGraph(m.tri, labels);
    checkPlaneGraph(rg.graph);
    const res = solver.solve(rg.graph, { verify: true });
    verifyColoring(rg.graph, res.colors);
  });

  test('全体が 1 領域 / 2 領域', () => {
    const m = generateMap({ numCells: 500, distribution: 'uniform', cellsPerRegion: 1, seed: 5, aspect: 1 });
    const one = buildRegionGraph(m.tri, new Int32Array(m.tri.numCells));
    assert.equal(one.graph.n, 2);
    solver.solve(one.graph, { verify: true });
    const labels = new Int32Array(m.tri.numCells);
    for (let c = 0; c < labels.length; c++) labels[c] = m.points[2 * c] < 0.5 ? 0 : 1;
    const two = buildRegionGraph(m.tri, labels);
    checkPlaneGraph(two.graph);
    solver.solve(two.graph, { verify: true });
  });
});

describe('三角形分割', () => {
  test('一般の平面グラフ(木・閉路・大きな面)を多重辺なしで三角形分割する', () => {
    for (const cpr of [1, 8, 64]) {
      const m = generateMap({ numCells: 2000, distribution: 'uniform', cellsPerRegion: cpr, seed: 11, aspect: 1 });
      const rg = buildRegionGraph(m.tri, m.labels);
      if (rg.graph.n < 5) continue;
      const tri = Tri.fromRotation(rg.graph);
      tri.triangulateAll();
      tri.checkTriangulation();
    }
    // 道グラフ・星グラフ
    const path: RotationSystem = {
      n: 6,
      offsets: Uint32Array.from([0, 1, 3, 5, 7, 9, 10]),
      neighbors: Uint32Array.from([1, 0, 2, 1, 3, 2, 4, 3, 5, 4]),
    };
    const t1 = Tri.fromRotation(path);
    t1.triangulateAll();
    t1.checkTriangulation();
    const star: RotationSystem = {
      n: 7,
      offsets: Uint32Array.from([0, 6, 7, 8, 9, 10, 11, 12]),
      neighbors: Uint32Array.from([1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0]),
    };
    const t2 = Tri.fromRotation(star);
    t2.triangulateAll();
    t2.checkTriangulation();
    solver.solve(path, { verify: true });
    solver.solve(star, { verify: true });
  });
});

/** 向きのそろった三角形の一覧から rotation system を作る */
function fromTriangles(n: number, tris: number[][]): RotationSystem {
  const next: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (const [a, b, c] of tris) {
    next[a].set(b, c);
    next[b].set(c, a);
    next[c].set(a, b);
  }
  const offsets = new Uint32Array(n + 1);
  const nb: number[] = [];
  for (let v = 0; v < n; v++) {
    offsets[v] = nb.length;
    const m = next[v];
    const s = m.keys().next().value as number;
    let x = s;
    do {
      nb.push(x);
      x = m.get(x)!;
    } while (x !== s);
    assert.equal(nb.length - offsets[v], m.size);
  }
  offsets[n] = nb.length;
  return { n, offsets, neighbors: Uint32Array.from(nb) };
}

/** 正二十面体を k 個、面どうしで貼り合わせた鎖。全頂点の次数が 5 以上で、分離三角形が k-1 個ある。 */
function icosahedronChain(k: number): RotationSystem {
  let tris: number[][] = [];
  const remap = new Map<number, number>();
  let prevFace: number[] | null = null;
  for (let b = 0; b < k; b++) {
    const base = 12 * b;
    const T = base, B = base + 1;
    const u = (i: number) => base + 2 + (i % 5), l = (i: number) => base + 7 + (i % 5);
    let t: number[][] = [];
    for (let i = 0; i < 5; i++) {
      t.push([T, u(i), u(i + 1)], [u(i + 1), u(i), l(i)], [u(i + 1), l(i), l(i + 1)], [B, l(i + 1), l(i)]);
    }
    const isFace = (f: number[], x: number, y: number, z: number) => f.includes(x) && f.includes(y) && f.includes(z);
    if (prevFace) {
      t = t.filter((f) => !isFace(f, T, u(0), u(1)));
      remap.set(T, prevFace[0]);
      remap.set(u(0), prevFace[2]);
      remap.set(u(1), prevFace[1]);
    }
    if (b < k - 1) t = t.filter((f) => !isFace(f, B, l(0), l(1)));
    tris = tris.concat(t);
    prevFace = [B, l(1), l(0)];
  }
  const id = new Map<number, number>();
  const get = (v: number): number => {
    while (remap.has(v)) v = remap.get(v)!;
    let r = id.get(v);
    if (r === undefined) id.set(v, (r = id.size));
    return r;
  };
  const mapped = tris.map((f) => f.map(get));
  return fromTriangles(id.size, mapped);
}

describe('4 彩色', () => {
  test('次数 5 以上で分離三角形だらけのグラフ(二十面体の鎖)', () => {
    for (const k of [1, 2, 3, 7, 50, 600]) {
      const g = icosahedronChain(k);
      assert.equal(g.n, 9 * k + 3);
      checkPlaneGraph(g);
      for (const identifyDegree4 of [true, false]) {
        const res = solver.solve(g, { verify: true, identifyDegree4 });
        assert.equal(res.stats.fallbackVertices, 0);
        assert.ok(res.stats.configsD > 0, '次数 3, 4 の頂点がないので D の配置が必要');
      }
    }
  });

  for (const dist of ['uniform', 'jitter', 'hex'] as const) {
    test(`${dist}: 小〜中規模を多数のシードで`, () => {
      for (const n of [16, 30, 60, 150, 400, 1500]) {
        for (let seed = 1; seed <= 12; seed++) {
          const { res } = solveMap(n, dist, 1, seed);
          assert.equal(res.stats.fallbackVertices, 0, `fallback used (n=${n}, seed=${seed})`);
        }
      }
    });
    test(`${dist}: 5 万セル`, () => {
      const { res } = solveMap(50000, dist, 1, 2026);
      assert.equal(res.stats.fallbackVertices, 0);
      assert.ok(res.stats.configsD > 0);
    });
  }

  test('複数セルの領域', () => {
    for (const cpr of [2, 4, 16, 64]) {
      for (let seed = 1; seed <= 5; seed++) {
        const { res } = solveMap(20000, 'uniform', cpr, seed);
        assert.equal(res.stats.fallbackVertices, 0);
      }
    }
  });

  test('論文 3.1 節どおりのランダム Kempe 変更でも塗れる', () => {
    for (const dist of ['uniform', 'hex'] as const) {
      for (const identify of [true, false]) {
        const { res } = solveMap(20000, dist, 1, 99, 'random', identify);
        assert.equal(res.stats.fallbackVertices, 0);
      }
    }
  });

  test('次数 4 の頂点も補助辺 + Kempe 変更だけで処理する設定(同一視なし)', () => {
    for (const dist of ['uniform', 'jitter', 'hex'] as const) {
      for (const n of [30, 200, 3000, 30000]) {
        for (let seed = 1; seed <= 4; seed++) {
          const { res } = solveMap(n, dist, 1, seed, 'greedy', false);
          assert.equal(res.stats.fallbackVertices, 0);
          assert.equal(res.stats.identified, 0);
        }
      }
    }
    const { res } = solveMap(20000, 'uniform', 8, 5, 'greedy', false);
    assert.equal(res.stats.fallbackVertices, 0);
  });

  test('同一視ありでは次数 4 の頂点の大半が Kempe 変更なしで済む', () => {
    const { res } = solveMap(30000, 'uniform', 1, 3);
    assert.ok(res.stats.identified > res.stats.configsDeg4 * 0.8);
  });

  test('セル数がごく少ない入力', () => {
    for (const n of [16, 17, 18, 20, 24]) {
      for (let seed = 1; seed <= 20; seed++) solveMap(n, 'uniform', 1, seed);
    }
  });

  test('同じ入力・同じシードなら同じ結果', () => {
    const a = solveMap(5000, 'jitter', 1, 4).res.colors;
    const b = solveMap(5000, 'jitter', 1, 4).res.colors;
    assert.deepEqual(a, b);
  });
});
