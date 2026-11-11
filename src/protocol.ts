import type { SolveStats } from './core/types';

/** 点の分布。'hex' は三角格子に微小な揺らぎ(ほぼ全頂点が次数6の「平坦」な最難ケース)。 */
export type Distribution = 'uniform' | 'jitter' | 'hex';

export interface GenerateParams {
  /** Voronoi セル数 */
  numCells: number;
  distribution: Distribution;
  /** 1 領域あたりの平均セル数 (1 = セルがそのまま領域) */
  cellsPerRegion: number;
  seed: number;
  /** 地図の横/縦比。座標は x∈[0,aspect], y∈[0,1] */
  aspect: number;
}

export interface ColorStats {
  /** 領域(=グラフの頂点)数。外側の「海」頂点を含む */
  numRegions: number;
  /** 領域グラフ構築にかかった時間 (ms) */
  msGraph: number;
  /** ワーカー内での recolor 全体の時間 (ms) */
  msTotal: number;
  solve: SolveStats;
}

/** 彩色の設定(省略時はソルバの既定値) */
export interface ColorOptions {
  /** Kempe 変更の選び方。'greedy' (既定) / 'random' (論文 3.1 節どおり) */
  kempeMode?: 'greedy' | 'random';
  /** 次数 4 の頂点を隣接 2 頂点の同一視で処理するか (既定 true)。false なら補助辺 + Kempe 変更 */
  identifyDegree4?: boolean;
}

/** メインスレッド → ワーカー */
export type ToWorker =
  /** 地図を生成し、続けて reqId 0 として彩色する */
  | ({ type: 'generate'; params: GenerateParams } & ColorOptions)
  /** labels はセルごとの領域ラベル (長さ numCells)。同じラベルでも連結でなければ別領域として扱われる */
  | ({ type: 'recolor'; reqId: number; labels: Int32Array } & ColorOptions);

/** ワーカー → メインスレッド */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'progress'; phase: string }
  | {
      type: 'map';
      params: GenerateParams;
      /** x0,y0,x1,y1,... (長さ 2*numCells) */
      points: Float32Array;
      /** セルの Delaunay 隣接 (CSR)。最近傍サイト探索と編集時の連結成分探索に使う */
      nbrOffsets: Uint32Array;
      nbrs: Uint32Array;
      labels: Int32Array;
      msGenerate: number;
    }
  | { type: 'colors'; reqId: number; colors: Uint8Array; stats: ColorStats }
  | { type: 'error'; reqId?: number; message: string };
