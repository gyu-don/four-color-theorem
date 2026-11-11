import type { RotationSystem } from '../core/types';

/** Delaunator の出力と同じ形式のセル三角形分割 */
export interface CellTriangulation {
  numCells: number;
  /** 三角形 t の頂点は triangles[3t..3t+2] */
  triangles: Uint32Array;
  /** 半辺 e の反対側の半辺 (凸包上は -1) */
  halfedges: Int32Array;
}

export interface RegionGraph {
  /** 領域の隣接グラフ(単純・連結・平面、rotation system 付き)。最後の頂点は外側の「海」 */
  graph: RotationSystem;
  /** 各セルが属するグラフ頂点 */
  cellVertex: Int32Array;
  /** 海頂点の番号 (= graph.n - 1) */
  seaVertex: number;
}

/**
 * セルのラベルから領域グラフを作る。同じラベルで Delaunay 隣接するセルの連結成分が 1 領域になる。
 *
 * 手順:
 *  1. 凸包の外側に「海」頂点を足して、セルの Delaunay 三角形分割を球面上の閉じた三角形分割にする。
 *  2. 同ラベルの連結成分を領域(グラフ頂点)とする。
 *  3. 各領域を 1 点に縮約したときの rotation system を、領域の境界をたどって求める。
 *     穴のある領域は境界が複数の閉路になるが、それらを単につなげばよい
 *     (縮約後その頂点は切断点になり、穴の中身はどの角に置いても平面的)。
 *  4. 同じ 2 領域間の多重辺は 1 本だけ残す(両側で同じ物理的な辺を残す)。
 * 結果の面は三角形とは限らない(ソルバ側で三角形分割する)。
 */
export function buildRegionGraph(tri: CellTriangulation, labels: Int32Array): RegionGraph {
  const N = tri.numCells;
  const { triangles, halfedges } = tri;
  const E = triangles.length;
  if (E === 0) return starGraph(N);

  // --- 1. 海頂点 N を足して閉じる ---
  let hull = 0;
  for (let e = 0; e < E; e++) if (halfedges[e] < 0) hull++;
  const E2 = E + 3 * hull;
  const org = new Uint32Array(E2);
  const twin = new Int32Array(E2);
  org.set(triangles);
  twin.set(halfedges);
  const hullOut = new Int32Array(N).fill(-1); // 頂点から出る凸包辺の番号
  const hullIn = new Int32Array(N).fill(-1); // 頂点に入る凸包辺の番号
  {
    let i = 0;
    for (let e = 0; e < E; e++) {
      if (halfedges[e] >= 0) continue;
      const a = triangles[e];
      const b = triangles[e % 3 === 2 ? e - 2 : e + 1];
      const base = E + 3 * i;
      org[base] = b; // b→a
      org[base + 1] = a; // a→海
      org[base + 2] = N; // 海→b
      twin[e] = base;
      twin[base] = e;
      hullOut[a] = i;
      hullIn[b] = i;
      i++;
    }
    for (let j = 0; j < hull; j++) {
      const base = E + 3 * j;
      const a = org[base + 1];
      const b = org[base];
      // (a→海) の相方は、a に入る凸包辺の三角形にある (海→a)
      twin[base + 1] = E + 3 * hullIn[a] + 2;
      // (海→b) の相方は、b から出る凸包辺の三角形にある (b→海)
      twin[base + 2] = E + 3 * hullOut[b] + 1;
    }
  }
  // dest(e) = org[next(e)], rotNext(e) = next(twin[e])
  const out = new Int32Array(N + 1).fill(-1);
  for (let e = 0; e < E2; e++) out[org[e]] = e;

  // --- 2. 連結成分 ---
  const comp = new Int32Array(N + 1).fill(-1);
  const stack = new Int32Array(N);
  let nc = 0;
  for (let c = 0; c < N; c++) {
    if (comp[c] >= 0) continue;
    if (out[c] < 0) throw new Error(`cell ${c} is not part of the triangulation`);
    const id = nc++;
    const lab = labels[c];
    comp[c] = id;
    let sp = 0;
    stack[sp++] = c;
    while (sp > 0) {
      const x = stack[--sp];
      const e0 = out[x];
      let e = e0;
      do {
        const y = org[e % 3 === 2 ? e - 2 : e + 1];
        if (y < N && comp[y] < 0 && labels[y] === lab) {
          comp[y] = id;
          stack[sp++] = y;
        }
        const t = twin[e];
        e = t % 3 === 2 ? t - 2 : t + 1;
      } while (e !== e0);
    }
  }
  const sea = nc++;
  comp[N] = sea;

  // --- 3. 境界をたどって rotation を作る ---
  const cnt = new Uint32Array(nc + 1);
  for (let e = 0; e < E2; e++) {
    const a = comp[org[e]];
    if (a !== comp[org[e % 3 === 2 ? e - 2 : e + 1]]) cnt[a + 1]++;
  }
  for (let r = 0; r < nc; r++) cnt[r + 1] += cnt[r];
  const total = cnt[nc];
  const fill = new Uint32Array(nc);
  for (let r = 0; r < nc; r++) fill[r] = cnt[r];
  const list = new Int32Array(total);
  const visited = new Uint8Array(E2);
  for (let e = 0; e < E2; e++) {
    if (visited[e]) continue;
    const r = comp[org[e]];
    if (r === comp[org[e % 3 === 2 ? e - 2 : e + 1]]) continue;
    let x = e;
    do {
      visited[x] = 1;
      list[fill[r]++] = x;
      // x=(a→b) の次: a のまわりで次の半辺 y。y が領域内の辺 (a→c) なら c に移り、
      // c のまわりで (c→a) の次の半辺 = next(y) へ進む。領域の外へ出る辺に当たるまで繰り返す。
      const t = twin[x];
      let y = t % 3 === 2 ? t - 2 : t + 1;
      while (comp[org[y % 3 === 2 ? y - 2 : y + 1]] === r) {
        y = y % 3 === 2 ? y - 2 : y + 1;
      }
      x = y;
    } while (x !== e);
  }

  // --- 4. 多重辺の除去 ---
  const offsets = new Uint32Array(nc + 1);
  const neighbors = new Uint32Array(total);
  const stampArr = new Int32Array(nc).fill(-1);
  const best = new Int32Array(nc);
  let w = 0;
  for (let r = 0; r < nc; r++) {
    offsets[r] = w;
    const s0 = cnt[r], s1 = cnt[r + 1];
    for (let i = s0; i < s1; i++) {
      const x = list[i];
      const s = comp[org[x % 3 === 2 ? x - 2 : x + 1]];
      const t = twin[x];
      const id = x < t ? x : t;
      if (stampArr[s] !== r) {
        stampArr[s] = r;
        best[s] = id;
      } else if (id < best[s]) {
        best[s] = id;
      }
    }
    for (let i = s0; i < s1; i++) {
      const x = list[i];
      const s = comp[org[x % 3 === 2 ? x - 2 : x + 1]];
      const t = twin[x];
      if ((x < t ? x : t) === best[s]) neighbors[w++] = s;
    }
  }
  offsets[nc] = w;
  return {
    graph: { n: nc, offsets, neighbors: neighbors.subarray(0, w) },
    cellVertex: comp.subarray(0, N),
    seaVertex: sea,
  };
}

/** 三角形が 1 つもない退化した入力(セル 2 個以下など): 各セルが海とだけ隣接する星グラフにする。 */
function starGraph(N: number): RegionGraph {
  const n = N + 1;
  const offsets = new Uint32Array(n + 1);
  const neighbors = new Uint32Array(2 * N);
  for (let c = 0; c < N; c++) {
    offsets[c] = c;
    neighbors[c] = N;
  }
  offsets[N] = N;
  for (let c = 0; c < N; c++) neighbors[N + c] = c;
  offsets[n] = 2 * N;
  const cellVertex = new Int32Array(N);
  for (let c = 0; c < N; c++) cellVertex[c] = c;
  return { graph: { n, offsets, neighbors }, cellVertex, seaVertex: N };
}
