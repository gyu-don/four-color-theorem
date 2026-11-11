// Web Worker: 地図の生成と 4 彩色。プロトコルは src/protocol.ts を参照。
import { FourColorSolver } from './core/index';
import { generateMap } from './map/generate';
import { buildRegionGraph } from './map/regionGraph';
import type { CellTriangulation } from './map/regionGraph';
import type { ColorOptions, ColorStats, FromWorker, GenerateParams, ToWorker } from './protocol';
import { applyPermutation, bestPermutation } from './ui/colorMatch';

interface RecolorRequest {
  reqId: number;
  labels: Int32Array;
  options: ColorOptions;
}
interface GenerateRequest {
  params: GenerateParams;
  options: ColorOptions;
}

const scope = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

// ---------------------------------------------------------------------------
// 状態

let solver: FourColorSolver | null = null;
/** 現在の地図の三角形分割(領域グラフの構築に使う) */
let tri: CellTriangulation | null = null;
let mapSeed = 1;
/** 直前に送ったセルごとの色(色の安定化用) */
let prevColors: Uint8Array | null = null;

/** 未処理の要求。新しい要求が来たら古いものは上書きされる(最新のものだけ処理する) */
let pendingGenerate: GenerateRequest | null = null;
let pendingRecolor: RecolorRequest | null = null;
let scheduled = false;

function schedule(): void {
  if (scheduled || solver === null) return;
  if (pendingGenerate === null && pendingRecolor === null) return;
  scheduled = true;
  // setTimeout を挟むことで、処理中に溜まったメッセージがまとめて受信され、最新だけが残る
  setTimeout(pump, 0);
}

function pump(): void {
  scheduled = false;
  if (pendingGenerate !== null) {
    const p = pendingGenerate;
    pendingGenerate = null;
    try {
      doGenerate(p);
    } catch (e) {
      post({ type: 'error', message: errorMessage(e) });
    }
  } else if (pendingRecolor !== null) {
    const r = pendingRecolor;
    pendingRecolor = null;
    try {
      doRecolor(r);
    } catch (e) {
      post({ type: 'error', reqId: r.reqId, message: errorMessage(e) });
    }
  }
  schedule();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 生成

function doGenerate(req: GenerateRequest): void {
  const t0 = performance.now();
  const map = generateMap(req.params, (phase) => post({ type: 'progress', phase }));
  const msGenerate = performance.now() - t0;
  tri = map.tri;
  mapSeed = map.params.seed;
  prevColors = null;
  // 初回の彩色に使うラベルは複製を手元に残し、元の配列はメインスレッドへ渡す
  const labelsCopy = map.labels.slice();
  post(
    {
      type: 'map',
      params: map.params,
      points: map.points,
      nbrOffsets: map.nbrOffsets,
      nbrs: map.nbrs,
      labels: map.labels,
      msGenerate,
    },
    [map.points.buffer, map.nbrOffsets.buffer, map.nbrs.buffer, map.labels.buffer],
  );
  post({ type: 'progress', phase: '彩色中…' });
  try {
    doRecolor({ reqId: 0, labels: labelsCopy, options: req.options });
  } catch (e) {
    post({ type: 'error', reqId: 0, message: errorMessage(e) });
  }
}

// ---------------------------------------------------------------------------
// 彩色

function doRecolor(req: RecolorRequest): void {
  const t0 = performance.now();
  if (solver === null) throw new Error('ソルバが初期化されていません');
  if (tri === null) throw new Error('地図がまだ生成されていません');
  const { labels } = req;
  const n = tri.numCells;
  if (labels.length !== n) throw new Error(`ラベル配列の長さ ${labels.length} がセル数 ${n} と一致しません`);

  const tg = performance.now();
  const rg = buildRegionGraph(tri, labels);
  const msGraph = performance.now() - tg;
  const res = solver.solve(rg.graph, {
    kempeMode: req.options.kempeMode,
    identifyDegree4: req.options.identifyDegree4,
    seed: mapSeed,
  });
  const colors = new Uint8Array(n);
  const cv = rg.cellVertex;
  const rc = res.colors;
  for (let i = 0; i < n; i++) colors[i] = rc[cv[i]];
  const stats = res.stats;
  const numRegions = rg.graph.n;

  // 色の安定化: 前回と同じ色のままのセルが最大になるよう 4 色を置換する
  if (prevColors !== null && prevColors.length === n) {
    applyPermutation(colors, bestPermutation(prevColors, colors));
  }
  prevColors = colors.slice();

  const result: ColorStats = { numRegions, msGraph, msTotal: performance.now() - t0, solve: stats };
  post({ type: 'colors', reqId: req.reqId, colors, stats: result }, [colors.buffer]);
}

// ---------------------------------------------------------------------------
// メッセージ処理

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as ToWorker;
  const options: ColorOptions = { kempeMode: msg.kempeMode, identifyDegree4: msg.identifyDegree4 };
  if (msg.type === 'generate') {
    pendingGenerate = { params: msg.params, options };
    pendingRecolor = null; // 古い地図への要求は捨てる
  } else if (msg.type === 'recolor') {
    pendingRecolor = { reqId: msg.reqId, labels: msg.labels, options };
  }
  schedule();
};

FourColorSolver.create().then(
  (s) => {
    solver = s;
    post({ type: 'ready' });
    schedule();
  },
  (e: unknown) => post({ type: 'error', message: `ソルバの初期化に失敗しました: ${errorMessage(e)}` }),
);
