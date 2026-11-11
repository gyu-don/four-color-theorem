import { type ConfigLibrary, loadConfigLibrary } from './configs';
import { solveWithLibrary } from './solver';
import type { RotationSystem, SolveOptions, SolveResult } from './types';

export type { RotationSystem, SolveOptions, SolveResult, SolveStats } from './types';
export { verifyColoring } from './solver';

/**
 * 近線形時間 4 彩色ソルバ (Inoue, Kawarabayashi, Miyashita, Mohar, Thomassen, Thorup; arXiv:2603.24880)。
 * create() で可約配置データを展開して照合用の構造を作る(1 回だけ)。
 */
export class FourColorSolver {
  private constructor(private readonly lib: ConfigLibrary) {}

  static async create(): Promise<FourColorSolver> {
    return new FourColorSolver(await loadConfigLibrary());
  }

  /** 集合 D の配置数(次数 3, 4 の単独頂点を含む) */
  get configCount(): number {
    return this.lib.configs.length;
  }

  /** 連結な単純平面グラフ(rotation system)を 4 彩色する。 */
  solve(graph: RotationSystem, opts: SolveOptions = {}): SolveResult {
    return solveWithLibrary(this.lib, graph, opts);
  }
}
