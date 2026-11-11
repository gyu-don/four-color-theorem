// 最近傍サイト探索(Delaunay 隣接上の貪欲歩行)と、画素ごとのセル番号バッファ(ID バッファ)の計算。
// DOM 非依存。

/** サイト座標と Delaunay 隣接 (CSR) */
export interface SiteGraph {
  numCells: number;
  points: Float32Array;
  nbrOffsets: Uint32Array;
  nbrs: Uint32Array;
}

/**
 * start から、(x,y) により近い隣接サイトへ移り続ける。Delaunay 三角形分割上の貪欲歩行は
 * 必ず真の最近傍サイトに到達する。
 */
export function nearestSite(g: SiteGraph, start: number, x: number, y: number): number {
  const pts = g.points;
  const off = g.nbrOffsets;
  const nb = g.nbrs;
  let c = start;
  let dx = pts[2 * c] - x;
  let dy = pts[2 * c + 1] - y;
  let best = dx * dx + dy * dy;
  for (;;) {
    let next = -1;
    for (let p = off[c], end = off[c + 1]; p < end; p++) {
      const q = nb[p];
      dx = pts[2 * q] - x;
      dy = pts[2 * q + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        next = q;
      }
    }
    if (next < 0) return c;
    c = next;
  }
}

/** 総当たりの最近傍(テスト用) */
export function nearestSiteBrute(g: SiteGraph, x: number, y: number): number {
  const pts = g.points;
  let best = Infinity;
  let arg = -1;
  for (let i = 0; i < g.numCells; i++) {
    const dx = pts[2 * i] - x;
    const dy = pts[2 * i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      arg = i;
    }
  }
  return arg;
}

/**
 * 各セルについて「サイトからこの距離以内の点の最近傍は必ずこのサイト」と言える半径の 2 乗
 * (最も近い隣接サイトまでの距離の半分。最近傍グラフは Delaunay グラフに含まれるので隣接だけ見ればよい)。
 */
export function computeSafeRadii(g: SiteGraph): Float32Array {
  const { points: pts, nbrOffsets: off, nbrs: nb } = g;
  const out = new Float32Array(g.numCells);
  for (let c = 0; c < g.numCells; c++) {
    const x = pts[2 * c];
    const y = pts[2 * c + 1];
    let m = Infinity;
    for (let p = off[c], end = off[c + 1]; p < end; p++) {
      const q = nb[p];
      const dx = pts[2 * q] - x;
      const dy = pts[2 * q + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < m) m = d;
    }
    // (d/2)² に丸め誤差の余裕を持たせる
    out[c] = m === Infinity ? 0 : m * 0.25 * 0.999;
  }
  return out;
}

/** 画素格子とワールド座標の対応。画素 (i,j) の中心は (originX + (i+0.5)·pixelSize, originY + (j+0.5)·pixelSize) */
export interface RasterSpec {
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** 1 画素のワールド座標での大きさ */
  pixelSize: number;
  /** 地図の横幅 (x∈[0,aspect], y∈[0,1] の外側の画素は -1) */
  aspect: number;
  /** step 画素ごとに 1 回だけ計算して step×step のブロックを埋める (1 = 全画素) */
  step: number;
}

/** 貪欲歩行の本体(safe があれば内接円の内側で打ち切る) */
function walk(
  pts: Float32Array,
  off: Uint32Array,
  nb: Uint32Array,
  safe: Float32Array | null,
  c: number,
  x: number,
  y: number,
): number {
  let dx = pts[2 * c] - x;
  let dy = pts[2 * c + 1] - y;
  let best = dx * dx + dy * dy;
  for (;;) {
    // 内接円の内側なら隣接を調べるまでもなく c が最近傍
    if (safe !== null && best <= safe[c]) return c;
    let next = -1;
    for (let p = off[c], end = off[c + 1]; p < end; p++) {
      const q = nb[p];
      dx = pts[2 * q] - x;
      dy = pts[2 * q + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        next = q;
      }
    }
    if (next < 0) return c;
    c = next;
  }
}

/** 全解像度の計算で使う格子ブロックの一辺(画素) */
const BLOCK = 8;

/**
 * out[j*width+i] = 画素 (i,j) の中心に最も近いサイトの番号 (地図の外なら -1)。
 * 走査線に沿って直前の画素のセルから歩き始める。hint は最初の開始セル。戻り値は次回の hint に使えるセル。
 *
 * step = 1 のときは BLOCK 画素ごとの格子点を先に求め、ブロックの 4 隅が同じセルなら
 * ブロック全体をそのセルで埋める(Voronoi セルも地図の矩形も凸なので、4 隅の凸包はそのセルに含まれる)。
 * step > 1 のときは step×step のブロックごとに中心の 1 画素だけを計算する(操作中の粗い表示)。
 * safeR2 (computeSafeRadii) を渡すと、サイトの内接円の内側の画素で隣接の確認を省く。
 */
export function computeCellBuffer(
  g: SiteGraph,
  out: Int32Array,
  spec: RasterSpec,
  hint: number,
  safeR2: Float32Array | null = null,
): number {
  const { width: W, height: H, originX: ox, originY: oy, pixelSize: px, aspect } = spec;
  const step = Math.max(1, Math.floor(spec.step));
  if (g.numCells === 0) {
    out.fill(-1);
    return -1;
  }
  const safe = safeR2 !== null && safeR2.length === g.numCells ? safeR2 : null;
  const pts = g.points;
  const off = g.nbrOffsets;
  const nb = g.nbrs;
  let c = hint >= 0 && hint < g.numCells ? hint : 0;

  // セルが十分大きいとき(平均セル幅が BLOCK の 3 倍以上)だけブロック法を使う。小さいセルでは割に合わない
  const avgCellPx = Math.sqrt(aspect / g.numCells) / px;
  if (step > 1 || W < 2 || H < 2 || avgCellPx < 3 * BLOCK) {
    const half = step * 0.5;
    let rowStart = c;
    for (let j = 0; j < H; j += step) {
      const jEnd = j + step < H ? j + step : H;
      const y = oy + (j + half) * px;
      if (y < 0 || y > 1) {
        out.fill(-1, j * W, jEnd * W);
        continue;
      }
      c = rowStart;
      let haveRowStart = false;
      for (let i = 0; i < W; i += step) {
        const iEnd = i + step < W ? i + step : W;
        const x = ox + (i + half) * px;
        let cell = -1;
        if (x >= 0 && x <= aspect) {
          c = walk(pts, off, nb, safe, c, x, y);
          cell = c;
          if (!haveRowStart) {
            rowStart = c;
            haveRowStart = true;
          }
        }
        if (step === 1) {
          out[j * W + i] = cell;
          continue;
        }
        for (let jj = j; jj < jEnd; jj++) {
          const rowBase = jj * W;
          for (let ii = i; ii < iEnd; ii++) out[rowBase + ii] = cell;
        }
      }
    }
    return rowStart;
  }

  // --- 1. 格子点 (画素 kx·B, ky·B。最後は端の画素) のセル ---
  const nx = Math.ceil((W - 1) / BLOCK) + 1;
  const ny = Math.ceil((H - 1) / BLOCK) + 1;
  const node = new Int32Array(nx * ny);
  let rowStart = c;
  let firstValid = -1;
  for (let ky = 0; ky < ny; ky++) {
    const j = Math.min(ky * BLOCK, H - 1);
    const y = oy + (j + 0.5) * px;
    c = rowStart;
    let haveRowStart = false;
    for (let kx = 0; kx < nx; kx++) {
      const i = Math.min(kx * BLOCK, W - 1);
      const x = ox + (i + 0.5) * px;
      let cell = -1;
      if (x >= 0 && x <= aspect && y >= 0 && y <= 1) {
        c = walk(pts, off, nb, safe, c, x, y);
        cell = c;
        if (!haveRowStart) {
          rowStart = c;
          haveRowStart = true;
          if (firstValid < 0) firstValid = c;
        }
      }
      node[ky * nx + kx] = cell;
    }
  }

  // --- 2. ブロックごとに埋める ---
  c = firstValid >= 0 ? firstValid : c;
  for (let ky = 0; ky + 1 < ny; ky++) {
    const j0 = ky * BLOCK;
    const j1 = Math.min(j0 + BLOCK, H - 1);
    for (let kx = 0; kx + 1 < nx; kx++) {
      const i0 = kx * BLOCK;
      const i1 = Math.min(i0 + BLOCK, W - 1);
      const a = node[ky * nx + kx];
      const b = node[ky * nx + kx + 1];
      const d = node[(ky + 1) * nx + kx];
      const e = node[(ky + 1) * nx + kx + 1];
      if (a === b && a === d && a === e) {
        // 4 隅が同じセル(または 4 隅とも地図の外。地図の矩形はブロックより大きいので全体が外)
        for (let j = j0; j <= j1; j++) {
          const rowBase = j * W;
          for (let i = i0; i <= i1; i++) out[rowBase + i] = a;
        }
        continue;
      }
      if (a >= 0) c = a;
      else if (b >= 0) c = b;
      else if (d >= 0) c = d;
      else if (e >= 0) c = e;
      for (let j = j0; j <= j1; j++) {
        const y = oy + (j + 0.5) * px;
        const rowBase = j * W;
        const yIn = y >= 0 && y <= 1;
        let rc = c;
        for (let i = i0; i <= i1; i++) {
          const x = ox + (i + 0.5) * px;
          if (yIn && x >= 0 && x <= aspect) {
            c = walk(pts, off, nb, safe, c, x, y);
            out[rowBase + i] = c;
            if (i === i0) rc = c;
          } else {
            out[rowBase + i] = -1;
          }
        }
        c = rc;
      }
    }
  }
  return firstValid >= 0 ? firstValid : c;
}
