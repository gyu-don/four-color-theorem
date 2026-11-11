// ランダム地図の生成: 点(Voronoi サイト)の配置 → Hilbert 順への並べ替え → Delaunay 三角形分割
// → CSR 隣接 → 領域ラベル(ランダムな多始点成長)。DOM 非依存で、ワーカーとテストから使う。
import Delaunator from 'delaunator';
import type { GenerateParams } from '../protocol';
import type { CellTriangulation } from './regionGraph';

export interface GeneratedMap {
  params: GenerateParams;
  /** x0,y0,x1,y1,… ; x∈[0,aspect], y∈[0,1] */
  points: Float32Array;
  /** Delaunator の出力そのまま */
  tri: CellTriangulation;
  /** セルの Delaunay 隣接 (CSR)。長さ numCells+1 */
  nbrOffsets: Uint32Array;
  nbrs: Uint32Array;
  /** セルごとの領域ラベル 0..numRegions-1 */
  labels: Int32Array;
}

/** 生成の進行状況を知らせるコールバック(フェーズ名は日本語) */
export type ProgressCallback = (phase: string) => void;

/** 扱えるセル数の範囲 */
export const MIN_CELLS = 16;
export const MAX_CELLS = 4_000_000;

// ---------------------------------------------------------------------------
// 乱数

/** mulberry32: 32 ビット状態の小さな擬似乱数。[0,1) の一様乱数を返す関数を作る */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 点の配置

/** 一様ランダムな点 */
function uniformPoints(n: number, aspect: number, rand: () => number): Float64Array {
  const xy = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    xy[2 * i] = rand() * aspect;
    xy[2 * i + 1] = rand();
  }
  return xy;
}

/**
 * 三角格子(六方最密)上の点。各点を ±jitter 格子間隔の一様乱数でずらす。
 * 点数は n に近いが一致はしない。
 */
function latticePoints(n: number, aspect: number, jitter: number, rand: () => number): Float64Array {
  // 正三角形格子で 1 点が占める面積は s²·√3/2
  const s0 = Math.sqrt((2 * aspect) / (Math.sqrt(3) * n));
  const ny = Math.max(2, Math.round(1 / ((s0 * Math.sqrt(3)) / 2)));
  const nx = Math.max(2, Math.round(aspect / s0));
  const dx = aspect / nx;
  const dy = 1 / ny;
  const count = nx * ny;
  const xy = new Float64Array(2 * count);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    const shift = (j & 1) === 0 ? 0.25 : 0.75;
    for (let i = 0; i < nx; i++) {
      let x = (i + shift) * dx + (2 * rand() - 1) * jitter * dx;
      let y = (j + 0.5) * dy + (2 * rand() - 1) * jitter * dx;
      // 地図の矩形からはみ出さないようにする
      if (x < 0) x = 0;
      else if (x > aspect) x = aspect;
      if (y < 0) y = 0;
      else if (y > 1) y = 1;
      xy[k++] = x;
      xy[k++] = y;
    }
  }
  return xy;
}

// ---------------------------------------------------------------------------
// 空間順序 (Hilbert 曲線)

const HILBERT_ORDER = 16;
const HILBERT_N = 1 << HILBERT_ORDER;

/** 2^16 × 2^16 格子上の (x,y) の Hilbert 曲線上の位置 (0..2^32-1) */
export function hilbertIndex(x: number, y: number): number {
  let d = 0;
  for (let s = HILBERT_N >>> 1; s > 0; s >>>= 1) {
    const rx = (x & s) !== 0 ? 1 : 0;
    const ry = (y & s) !== 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - (x & (s - 1));
        y = s - 1 - (y & (s - 1));
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** Uint32 キーで安定に並べた添字列を返す(16 ビット 2 パスの LSD 基数ソート) */
function radixArgsort(keys: Uint32Array): Uint32Array {
  const n = keys.length;
  let src = new Uint32Array(n);
  let dst = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  const count = new Uint32Array(65536);
  for (let shift = 0; shift < 32; shift += 16) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(keys[i] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let b = 0; b < 65536; b++) {
      const c = count[b];
      count[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const idx = src[i];
      dst[count[(keys[idx] >>> shift) & 0xffff]++] = idx;
    }
    const t = src;
    src = dst;
    dst = t;
  }
  return src;
}

/** v 以下で最大の Float32 値(v ≥ 0) */
function float32AtMost(v: number): number {
  const f = new Float32Array(1);
  f[0] = v;
  if (f[0] > v) {
    const u = new Uint32Array(f.buffer);
    u[0] -= 1; // 正の数なので 1 ulp 小さくなる
  }
  return f[0];
}

/**
 * 点を Hilbert 順に並べ替え、Float32 に丸め、完全に一致する重複点を取り除く。
 * 三角形分割は丸めた後の座標で行う(UI 側の最近傍探索と一致させるため)。
 */
function orderAndRound(xy: Float64Array, aspect: number): Float32Array {
  const n = xy.length >>> 1;
  const keys = new Uint32Array(n);
  const scale = (HILBERT_N - 1) / Math.max(aspect, 1);
  for (let i = 0; i < n; i++) {
    const hx = Math.min(HILBERT_N - 1, Math.max(0, Math.floor(xy[2 * i] * scale)));
    const hy = Math.min(HILBERT_N - 1, Math.max(0, Math.floor(xy[2 * i + 1] * scale)));
    keys[i] = hilbertIndex(hx, hy);
  }
  const order = radixArgsort(keys);
  // Float32 に丸めても x ≤ aspect を保つための上限
  const maxX = float32AtMost(aspect);
  const out = new Float32Array(2 * n);
  let m = 0;
  let runStart = 0; // 同じキーが続く区間の先頭(出力側の添字)
  let prevKey = -1;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const key = keys[i];
    if (key !== prevKey) {
      runStart = m;
      prevKey = key;
    }
    let x = Math.fround(xy[2 * i]);
    if (x > maxX) x = maxX;
    const y = Math.fround(xy[2 * i + 1]); // y∈[0,1] は丸めても範囲内
    // 同一キーの区間はごく短いので総当たりで重複を調べる
    let dup = false;
    for (let q = runStart; q < m; q++) {
      if (out[2 * q] === x && out[2 * q + 1] === y) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    out[2 * m] = x;
    out[2 * m + 1] = y;
    m++;
  }
  return m === n ? out : out.slice(0, 2 * m);
}

// ---------------------------------------------------------------------------
// 隣接

/** 三角形分割からセルの CSR 隣接(各辺を両方向、重複なし)を作る */
export function buildCellAdjacency(tri: CellTriangulation): { nbrOffsets: Uint32Array; nbrs: Uint32Array } {
  const { numCells, triangles, halfedges } = tri;
  const E = triangles.length;
  const deg = new Uint32Array(numCells + 1);
  for (let e = 0; e < E; e++) {
    const h = halfedges[e];
    if (h === -1 || e < h) {
      deg[triangles[e]]++;
      deg[triangles[e % 3 === 2 ? e - 2 : e + 1]]++;
    }
  }
  const nbrOffsets = new Uint32Array(numCells + 1);
  for (let v = 0; v < numCells; v++) nbrOffsets[v + 1] = nbrOffsets[v] + deg[v];
  const fill = nbrOffsets.slice(0, numCells);
  const nbrs = new Uint32Array(nbrOffsets[numCells]);
  for (let e = 0; e < E; e++) {
    const h = halfedges[e];
    if (h === -1 || e < h) {
      const a = triangles[e];
      const b = triangles[e % 3 === 2 ? e - 2 : e + 1];
      nbrs[fill[a]++] = b;
      nbrs[fill[b]++] = a;
    }
  }
  return { nbrOffsets, nbrs };
}

// ---------------------------------------------------------------------------
// 領域ラベル

/**
 * ランダムに選んだ k 個の種セルから、フロンティアをランダムに取り出す多始点成長で領域を作る。
 * 各セルは同じラベルの隣接セルからラベルを受け取るので、各領域は連結になる。
 */
function growRegions(
  numCells: number,
  nbrOffsets: Uint32Array,
  nbrs: Uint32Array,
  numRegions: number,
  rand: () => number,
): Int32Array {
  const labels = new Int32Array(numCells).fill(-1);
  const frontier = new Uint32Array(numCells);
  let size = 0;
  let r = 0;
  while (r < numRegions) {
    const c = Math.floor(rand() * numCells);
    if (labels[c] !== -1) continue;
    labels[c] = r++;
    frontier[size++] = c;
  }
  while (size > 0) {
    const k = Math.floor(rand() * size);
    const c = frontier[k];
    const lab = labels[c];
    // c の未ラベル隣接セルを 1 つだけ取り込み、まだ残っていれば c をフロンティアに戻す
    let remaining = 0;
    let taken = -1;
    for (let p = nbrOffsets[c], end = nbrOffsets[c + 1]; p < end; p++) {
      const d = nbrs[p];
      if (labels[d] !== -1) continue;
      if (taken === -1) {
        taken = d;
        labels[d] = lab;
      } else {
        remaining++;
      }
    }
    if (remaining === 0) frontier[k] = frontier[--size];
    if (taken !== -1) frontier[size++] = taken;
  }
  return labels;
}

// ---------------------------------------------------------------------------

export function generateMap(params: GenerateParams, onProgress?: ProgressCallback): GeneratedMap {
  const aspect = params.aspect > 0 && Number.isFinite(params.aspect) ? params.aspect : 1;
  const want = Math.min(MAX_CELLS, Math.max(MIN_CELLS, Math.round(params.numCells)));
  const rand = mulberry32(params.seed);

  onProgress?.('点を配置中…');
  let raw: Float64Array;
  if (params.distribution === 'jitter') raw = latticePoints(want, aspect, 0.35, rand);
  else if (params.distribution === 'hex') raw = latticePoints(want, aspect, 0.02, rand);
  else raw = uniformPoints(want, aspect, rand);

  onProgress?.('空間順に並べ替え中…');
  const points = orderAndRound(raw, aspect);
  raw = new Float64Array(0);
  const numCells = points.length >>> 1;

  onProgress?.('Delaunay 三角形分割中…');
  const coords = new Float64Array(points.length);
  for (let i = 0; i < coords.length; i++) coords[i] = points[i];
  const d = new Delaunator(coords);
  const tri: CellTriangulation = { numCells, triangles: d.triangles, halfedges: d.halfedges };

  onProgress?.('隣接関係を構築中…');
  const { nbrOffsets, nbrs } = buildCellAdjacency(tri);
  for (let v = 0; v < numCells; v++) {
    if (nbrOffsets[v + 1] === nbrOffsets[v]) {
      throw new Error(`点 ${v} が三角形分割から抜け落ちた(重複点の可能性)`);
    }
  }

  onProgress?.('領域を作成中…');
  let labels: Int32Array;
  const cpr = params.cellsPerRegion;
  if (!(cpr > 1)) {
    labels = new Int32Array(numCells);
    for (let i = 0; i < numCells; i++) labels[i] = i;
  } else {
    const k = Math.min(numCells, Math.max(1, Math.round(numCells / cpr)));
    labels = growRegions(numCells, nbrOffsets, nbrs, k, rand);
  }

  return {
    params: { ...params, numCells, aspect },
    points,
    tri,
    nbrOffsets,
    nbrs,
    labels,
  };
}
