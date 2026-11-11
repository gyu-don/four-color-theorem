/**
 * 平面グラフの組合せ的埋め込み(rotation system)。
 * 頂点 v の隣接点は neighbors[offsets[v] .. offsets[v+1]) に、
 * 平面上で一貫した向き(全頂点で同じ回転方向)の巡回順で並ぶ。
 * グラフは連結・単純(ループ・多重辺なし)であること。三角形分割である必要はない。
 */
export interface RotationSystem {
  n: number;
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

export interface SolveOptions {
  /** 乱数シード(Kempe 変更のランダム選択に使用)。既定 1。 */
  seed?: number;
  /**
   * 'greedy' (既定): リングごとに、触れている Kempe 鎖を少しずつ探索し、小さな鎖の swap だけで
   *   リングを 0-extendible にできる組合せを見つけて確定していく(論文 12 節の決定的な選び方に近い)。
   * 'random': 論文 3.1 節そのまま。色の組分けをランダムに選び、鎖ごとに確率 1/2 で swap する。
   */
  kempeMode?: 'greedy' | 'random';
  /**
   * 次数 4 の頂点を「障害 4-閉路」として扱い、向かい合う隣接 2 頂点を同一視して縮約する
   * (論文 13 節 補題 13.1 (ii)。Kempe 変更が不要になる)。既定 true。
   * false にすると、次数 4 の頂点も D-可約配置として補助辺 + Kempe 変更で処理する(論文 3.1 節)。
   */
  identifyDegree4?: boolean;
  /** true のとき結果の彩色が proper かを検査して例外を投げる(テスト用)。 */
  verify?: boolean;
}

export interface SolveStats {
  /** 入力グラフの頂点数・辺数 */
  n: number;
  m: number;
  /** 三角形分割のために追加した辺の数 */
  triangulationEdges: number;
  /** 再帰の深さ(縮約レベル数) */
  levels: number;
  /** 使用した可約配置の数: 次数3の単独頂点 / 次数4の単独頂点 / 集合 D の 8200 個由来 */
  configsDeg3: number;
  configsDeg4: number;
  configsD: number;
  /** 次数 4 の単独頂点のうち、隣接 2 頂点の同一視で処理した数(configsDeg4 の内数) */
  identified: number;
  /** D の配置のうち実際に使われた異なる種類の数 */
  distinctD: number;
  /** Kempe 変更パスの総数 と そこで色を入れ替えた頂点の延べ数・探索した頂点の延べ数 */
  kempePasses: number;
  kempeFlipped: number;
  kempeExplored: number;
  /** 1 レベルで必要になった Kempe パス数の最大値 */
  maxPassesPerLevel: number;
  /**
   * 可約配置がどこにも見つからず、残りを総当たり(DSATUR + バックトラック)で塗った頂点数。通常 0。
   * (論文 13 節の一般の障害閉路の処理は実装していないため、その代わり)
   */
  fallbackVertices: number;
  /** 各フェーズの所要時間 (ms) */
  msTriangulate: number;
  msReduce: number;
  msMatch: number;
  msExtend: number;
  msTotal: number;
}

export interface SolveResult {
  /** 各頂点の色 0..3 */
  colors: Uint8Array;
  stats: SolveStats;
}
