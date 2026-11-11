/**
 * 平面三角形分割の近線形時間 4 彩色
 * (Inoue, Kawarabayashi, Miyashita, Mohar, Thomassen, Thorup, arXiv:2603.24880)。
 *
 * 全体の流れ(論文 3.1 節):
 *   1. 縮約 (reduce): 互いに接しない(本体どうしが頂点を共有せず、辺でも結ばれない)可約配置を
 *      1 レベルぶんまとめて取り除き、空いたリングの内側を補助辺で三角形分割する。これを繰り返す。
 *      配置は次数 3 の頂点、次数 4 の頂点、集合 D の 8200 個。
 *   2. 基底 (colorBase): 4 頂点以下になったら別々の色を塗る。
 *   3. 復元 (extendAll): レベルを逆順に戻す。そのレベルの配置はリングだけが塗られた状態になるので、
 *      大域的な Kempe 変更(色の組分けを 1 つ選び、2 色成分 = Kempe 鎖をいくつか同時に swap)を
 *      繰り返して各リングの彩色を 0-extendible にし、本体を塗る。
 *
 * 論文の記述と違う点:
 *   - 配置の探索は放電規則によらず、D 全体をトライで直接照合する(見つかる配置の集合は同じかそれ以上)。
 *     リングの頂点どうしが一致する出現も使う(D-可約性の議論は面の境界歩道に対して成り立つ)。
 *   - Kempe 変更の選び方: 論文 12 節は「リング彩色ごとの Kempe レベル表」を使う条件付き期待値法だが、
 *     その表は持たず、リングに触れる鎖を少しずつ同時に探索して「探索し終えた小さな鎖の swap だけで
 *     0-extendible になる組合せ」を見つけては確定する。1 手で直せないリングはランダムな swap で揺さぶる。
 *     kempeMode: 'random' なら 3.1 節の完全ランダム版そのもの。
 *   - 次数 4 の頂点は既定で、13 節(補題 13.1 (ii))の「向かい合う 2 頂点の同一視」で処理する
 *     (ループや多重辺ができる場合だけ補助辺 + Kempe 変更)。
 *   - 13 節の一般の障害閉路(分離 3-, 4-, 5-閉路)の再帰は実装していない。配置がどこにも見つからなければ
 *     残りを総当たりで塗る(stats.fallbackVertices。これまでの試験では一度も起きていない)。
 */
import { type Config, type ConfigLibrary, Matcher, MAX_DEG, MAX_N, tryExtend } from './configs';
import { Tri } from './graph';
import type { RotationSystem, SolveOptions, SolveResult, SolveStats } from './types';

/** 伸長可能な Int32 配列 */
class IntVec {
  a: Int32Array;
  len = 0;
  constructor(cap = 1024) {
    this.a = new Int32Array(cap);
  }
  push(x: number): void {
    if (this.len === this.a.length) {
      const b = new Int32Array(this.len * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.len++] = x;
  }
  ensure(extra: number): void {
    if (this.len + extra > this.a.length) {
      const b = new Int32Array(Math.max(this.a.length * 2, this.len + extra));
      b.set(this.a);
      this.a = b;
    }
  }
}

const UNCOLORED = 4;
/** 単独頂点(次数 3,4)がこの割合より少ないレベルでは D の配置も探す: singles * SINGLES_FRAC < live */
const SINGLES_FRAC = 24;
/** 1 つのリングが 1 回の試行で Kempe 鎖の探索に使える頂点数の初期値 */
const BUDGET0 = 256;
/** 予算切れの失敗がこの回数に達するごとに予算を 2 倍にする(次数 4 の単独頂点 / D の配置) */
const GROW_SINGLE = 2;
const GROW_D = 3;
/** D の配置のリングがこの回数続けて直せなかったら、小さな鎖をランダムに swap して揺さぶる */
const PERTURB_AFTER = 3;
/** 同時探索の 1 巡で各鎖を何頂点ぶん伸ばすかの初期値(巡ごとに 2 倍) */
const QUANTUM0 = 2;
/** 1 つのリングについて 1 回の試行で試す swap パターン数の上限 */
const PATTERN_LIMIT = 96;
const FACE_BUF = 64;

// Kempe 鎖(探索リスト)の状態
const PARTIAL = 0; // 探索途中
const COMPLETE = 1; // 鎖全体を探索し終えた(swap 可能)
const FROZEN = 2; // 途中で打ち切った。このパスでは swap しない
const MERGED = 3; // 別のリストに併合された

function emptyStats(n: number, m: number): SolveStats {
  return {
    n, m,
    triangulationEdges: 0,
    levels: 0,
    configsDeg3: 0, configsDeg4: 0, configsD: 0, identified: 0, distinctD: 0,
    kempePasses: 0, kempeFlipped: 0, kempeExplored: 0, maxPassesPerLevel: 0,
    fallbackVertices: 0,
    msTriangulate: 0, msReduce: 0, msMatch: 0, msExtend: 0, msTotal: 0,
  };
}

/** 1 回の solve の状態 */
class Run {
  readonly tri: Tri;
  readonly n: number;
  readonly color: Uint8Array;
  readonly stats: SolveStats;
  private readonly matcher: Matcher;
  private rngState: number;

  // --- 縮約フェーズ ---
  /** 同じレベルで採用済みの配置(本体 + リング)に属する頂点の印 */
  private readonly blocked: Int32Array;
  private stamp = 0;
  private low = new IntVec();
  private lowSpare = new IntVec();
  private readonly inLow: Uint8Array;
  private readonly changed = new IntVec();
  private readonly inChanged: Uint8Array;
  private readonly pend = new IntVec();
  private readonly inPend: Uint8Array;
  private readonly anchors = new IntVec();
  private readonly anchorStamp: Int32Array;
  private anchorToken = 0;
  /** 前回の照合が根から距離 2 の頂点まで調べたか */
  private readonly deepFlag: Uint8Array;
  private fullScan = true;
  private readonly zMark: Int32Array;
  private zToken = 0;
  private readonly face = new Int32Array(FACE_BUF);
  private readonly faceN = new Int32Array(FACE_BUF);
  private readonly faceP = new Int32Array(FACE_BUF);
  private readonly ringV = new Int32Array(FACE_BUF);
  private readonly usedD: Uint8Array;

  // --- 採用した配置の記録 ---
  private readonly occCfg = new IntVec();
  private readonly occImg = new IntVec();
  private readonly occHe = new IntVec();
  /** 同一視で処理した配置なら mergePool 内の記録位置、そうでなければ -1 */
  private readonly occMerge = new IntVec();
  /** D の配置の出現の向き(Matcher.dir) */
  private readonly occDir = new IntVec();
  private readonly mergePool = new IntVec();
  private readonly identifyEnabled: boolean;
  private readonly pool = new IntVec(4096);
  private readonly levelStart = new IntVec(256);

  // --- Kempe フェーズ ---
  private readonly compId: Int32Array;
  private readonly compStamp: Int32Array;
  private readonly qnext: Int32Array;
  private passStamp = 0;
  private lc = 0;
  private lFirst = new Int32Array(1024);
  private lHead = new Int32Array(1024);
  private lTail = new Int32Array(1024);
  private lLastExp = new Int32Array(1024);
  private lSize = new Int32Array(1024);
  private lState = new Uint8Array(1024);
  private lDec = new Int8Array(1024);
  private readonly cls = new Uint8Array(5);
  private readonly partner = new Uint8Array(5);
  private readonly act = new Int32Array(MAX_N);
  private readonly ringCol = new Uint8Array(MAX_N);
  private readonly ringTry = new Uint8Array(MAX_N);
  private readonly ringLoc = new Uint8Array(MAX_N);
  private readonly loc = new Int32Array(MAX_N);
  private readonly und = new Uint8Array(MAX_N);
  private nu = 0;
  private readonly flipLoc = new Uint8Array(MAX_N);
  private readonly extOut = new Uint8Array(MAX_N);
  private testsLeft = 0;

  constructor(private readonly lib: ConfigLibrary, tri: Tri, stats: SolveStats, private readonly opts: SolveOptions) {
    this.tri = tri;
    const n = (this.n = tri.n);
    this.stats = stats;
    this.color = new Uint8Array(n).fill(UNCOLORED);
    this.matcher = new Matcher(lib, tri);
    this.rngState = ((opts.seed ?? 1) | 0) || 1;
    this.identifyEnabled = opts.identifyDegree4 !== false;
    this.blocked = new Int32Array(n);
    this.inLow = new Uint8Array(n);
    this.inChanged = new Uint8Array(n);
    this.inPend = new Uint8Array(n);
    this.anchorStamp = new Int32Array(n);
    this.deepFlag = new Uint8Array(n);
    this.zMark = new Int32Array(n);
    this.usedD = new Uint8Array(lib.configs.length);
    this.compId = new Int32Array(n);
    this.compStamp = new Int32Array(n);
    this.qnext = new Int32Array(n);
  }

  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return x >>> 0;
  }

  // ------------------------------------------------------------------
  // 縮約: 互いに接しない可約配置をまとめて取り除き、リングの内側を補助辺で三角形分割する
  // ------------------------------------------------------------------

  reduce(): void {
    const tri = this.tri;
    const { deg, alive } = tri;
    for (let v = 0; v < this.n; v++) {
      if (deg[v] <= 4) {
        this.low.push(v);
        this.inLow[v] = 1;
      }
    }
    while (tri.live > 4) {
      this.stamp++;
      const levelOcc = this.occCfg.len;
      this.levelStart.push(levelOcc);

      // (A) 次数 3, 4 の単独頂点
      const cur = this.low;
      this.low = this.lowSpare;
      this.low.len = 0;
      this.lowSpare = cur;
      for (let i = 0; i < cur.len; i++) {
        const v = cur.a[i];
        this.inLow[v] = 0;
        if (!alive[v] || deg[v] > 4) continue;
        if (this.blocked[v] === this.stamp || tri.live <= 4) {
          this.low.push(v);
          this.inLow[v] = 1;
          continue;
        }
        this.applySingle(v);
      }
      const singles = this.occCfg.len - levelOcc;

      // (B) 単独頂点が少ないレベルでは集合 D の配置も探す
      if (tri.live > 4 && singles * SINGLES_FRAC < tri.live) {
        const t0 = performance.now();
        this.scanD();
        this.stats.msMatch += performance.now() - t0;
      }

      if (this.occCfg.len === levelOcc) {
        // 念のため全頂点を走査し直す(差分追跡の取りこぼし対策)
        if (tri.live > 4) {
          this.fullScan = true;
          const t0 = performance.now();
          this.scanD();
          this.stats.msMatch += performance.now() - t0;
        }
        if (this.occCfg.len === levelOcc) {
          this.levelStart.len--;
          break;
        }
        this.rescued++;
      }
    }
    this.stats.levels = this.levelStart.len;
    let distinct = 0;
    for (let i = 2; i < this.usedD.length; i++) distinct += this.usedD[i];
    this.stats.distinctD = distinct;
  }

  /** 差分追跡では見つからず、全走査で配置が見つかった回数(0 のはず。検査用) */
  rescued = 0;

  private applySingle(v: number): void {
    const tri = this.tri;
    const d = tri.deg[v];
    const off = this.pool.len;
    this.pool.ensure(d + 1);
    const pa = this.pool.a;
    const stamp = this.stamp;
    let h = tri.first[v];
    for (let i = 0; i < d; i++) {
      const w = tri.to[h];
      pa[off + i] = w;
      this.blocked[w] = stamp;
      h = tri.nxt[h];
    }
    pa[off + d] = v;
    this.blocked[v] = stamp;
    this.pool.len = off + d + 1;
    if (d === 3) this.stats.configsDeg3++;
    else this.stats.configsDeg4++;
    this.applyOcc(d === 3 ? 0 : 1, off, 0);
  }

  private scanD(): void {
    const tri = this.tri;
    const { deg, alive, to, twin, nxt, first } = tri;
    const anchors = this.anchors;
    anchors.len = 0;
    const token = ++this.anchorToken;
    const as = this.anchorStamp;
    const deepFlag = this.deepFlag;
    if (this.fullScan) {
      this.fullScan = false;
      for (let i = 0; i < this.changed.len; i++) this.inChanged[this.changed.a[i]] = 0;
      this.changed.len = 0;
      for (let i = 0; i < this.pend.len; i++) this.inPend[this.pend.a[i]] = 0;
      this.pend.len = 0;
      for (let v = 0; v < this.n; v++) if (alive[v]) anchors.push(v);
    } else {
      // 前回の走査以降に辺が変わった頂点 x について、x と隣接点、
      // および前回の照合が距離 2 まで見ていた距離 2 の頂点だけを調べ直す
      const ch = this.changed;
      for (let i = 0; i < ch.len; i++) {
        const x = ch.a[i];
        this.inChanged[x] = 0;
        if (!alive[x]) continue;
        if (as[x] !== token) {
          as[x] = token;
          anchors.push(x);
        }
        const h0 = first[x];
        let h = h0;
        do {
          const y = to[h];
          if (as[y] !== token) {
            as[y] = token;
            anchors.push(y);
          }
          const g0 = twin[h];
          let g = nxt[g0];
          while (g !== g0) {
            const z = to[g];
            if (deepFlag[z] && as[z] !== token) {
              as[z] = token;
              anchors.push(z);
            }
            g = nxt[g];
          }
          h = nxt[h];
        } while (h !== h0);
      }
      ch.len = 0;
      const pd = this.pend;
      for (let i = 0; i < pd.len; i++) {
        const x = pd.a[i];
        this.inPend[x] = 0;
        if (alive[x] && as[x] !== token) {
          as[x] = token;
          anchors.push(x);
        }
      }
      pd.len = 0;
    }
    const blocked = this.blocked, stamp = this.stamp;
    const matcher = this.matcher;
    const configs = this.lib.configs;
    for (let i = 0; i < anchors.len; i++) {
      const a = anchors.a[i];
      if (!alive[a]) continue;
      const d = deg[a];
      if (d < 5 || d > 12) continue;
      if (tri.live <= 4) break;
      let requeue = false;
      if (blocked[a] === stamp) {
        requeue = true;
      } else {
        const ci = matcher.matchAt(a, blocked, stamp);
        deepFlag[a] = matcher.deep ? 1 : 0;
        if (ci >= 0) {
          const c = configs[ci];
          const N = c.N;
          const off = this.pool.len;
          this.pool.ensure(N);
          const pa = this.pool.a;
          const img = matcher.img;
          for (let k = 0; k < N; k++) {
            const x = img[k];
            pa[off + k] = x;
            blocked[x] = stamp;
          }
          this.pool.len = off + N;
          this.stats.configsD++;
          this.usedD[ci] = 1;
          this.applyOcc(ci, off, matcher.dir);
        } else if (matcher.sawBlocked) {
          requeue = true;
        }
      }
      if (requeue && !this.inPend[a]) {
        this.inPend[a] = 1;
        this.pend.push(a);
      }
    }
  }

  /** 配置の本体を取り除き、空いたリングの内側を補助辺で三角形分割する。 */
  private applyOcc(ci: number, off: number, dir: number): void {
    const tri = this.tri;
    const { to, deg } = tri;
    const c = this.lib.configs[ci];
    const R = c.R, S = c.S;
    const pa = this.pool.a;
    const zMark = this.zMark;
    const token = ++this.zToken;
    for (let j = 0; j < S; j++) zMark[pa[off + R + j]] = token;
    // リング上の半辺 e0 (穴が左側) を見つける
    let e0 = -1;
    for (let j = 0; j < S && e0 < 0; j++) {
      const z = pa[off + R + j];
      const h0 = tri.first[z];
      let h = h0;
      do {
        if (zMark[to[h]] !== token) {
          let e = tri.prv[tri.twin[h]];
          while (zMark[to[e]] === token) e = tri.prv[e];
          e0 = e;
          break;
        }
        h = tri.nxt[h];
      } while (h !== h0);
    }
    const heBefore = tri.heCount;
    for (let j = 0; j < S; j++) tri.removeVertex(pa[off + R + j]);
    const face = this.face;
    let k = 0;
    let h = e0;
    do {
      if (k === FACE_BUF) throw new Error('ring too long');
      face[k++] = h;
      h = tri.prv[tri.twin[h]];
    } while (h !== e0);
    if (k !== R) throw new Error(`ring length mismatch: expected ${R}, got ${k}`);
    // リング頂点を控えてから三角形分割(face は書き換えられる)
    const ringV = this.ringV;
    for (let i = 0; i < k; i++) ringV[i] = to[face[i]];
    let merge = -1;
    if (ci === 1 && this.identifyEnabled) merge = this.tryIdentify(face);
    if (merge < 0) tri.triangulateFace(face, k, this.faceN, this.faceP);
    else this.stats.identified++;
    for (let i = 0; i < k; i++) {
      const x = ringV[i];
      if (!tri.alive[x]) continue;
      if (deg[x] <= 4 && !this.inLow[x]) {
        this.inLow[x] = 1;
        this.low.push(x);
      }
      if (!this.inChanged[x]) {
        this.inChanged[x] = 1;
        this.changed.push(x);
      }
    }
    this.occCfg.push(ci);
    this.occImg.push(off);
    this.occHe.push(heBefore);
    this.occMerge.push(merge);
    this.occDir.push(dir);
  }

  /**
   * 次数 4 の頂点を取り除いた跡の四角形 (r0, r1, r2, r3) について、向かい合う 2 頂点を同一視できれば行う。
   * 同一視できるのは、2 頂点が非隣接で、四角形の残り 2 頂点以外に共通の隣接点がないとき
   * (さもないとループや多重辺ができる)。成功したら mergePool 内の記録位置を返す。
   */
  private tryIdentify(face: Int32Array): number {
    const tri = this.tri;
    const { to, twin, nxt, deg } = tri;
    for (let t = 0; t < 2; t++) {
      // 対 (r_t, r_{t+2})。次数の小さい方を c(つぶす側)にする
      const ra = to[twin[face[t]]], rc = to[twin[face[t + 2]]];
      const hb = deg[rc] <= deg[ra] ? face[t] : face[t + 2];
      const a = to[twin[hb]];
      const b = to[hb];
      const ebc = tri.prv[twin[hb]];
      const c = to[ebc];
      const d = to[nxt[hb]];
      if (tri.adjacent(a, c)) continue;
      let ok = true;
      const h0 = tri.first[c];
      let h = h0;
      do {
        const x = to[h];
        if (x !== b && x !== d && tri.adjacent(x, a)) {
          ok = false;
          break;
        }
        h = nxt[h];
      } while (h !== h0);
      if (!ok) continue;
      const off = this.mergePool.len;
      this.mergePool.ensure(7);
      tri.identify(hb, this.mergePool.a, off);
      this.mergePool.len = off + 7;
      return off;
    }
    return -1;
  }

  // ------------------------------------------------------------------
  // 基底: 残った高々 4 頂点、または配置が見つからなかった残りを塗る
  // ------------------------------------------------------------------

  colorBase(): void {
    const tri = this.tri;
    const alive = tri.alive, color = this.color;
    if (tri.live <= 4) {
      let c = 0;
      for (let v = 0; v < this.n; v++) if (alive[v]) color[v] = c++;
      return;
    }
    this.bruteForce();
  }

  /** フォールバック: DSATUR + バックトラック。小さな残りグラフ専用。 */
  private bruteForce(): void {
    const tri = this.tri;
    const { to, nxt, first, deg, alive } = tri;
    const color = this.color;
    const verts: number[] = [];
    for (let v = 0; v < this.n; v++) if (alive[v]) verts.push(v);
    if (verts.length > 5000) {
      throw new Error(`可約配置が見つからない残りグラフが大きすぎます (${verts.length} 頂点)`);
    }
    this.stats.fallbackVertices += verts.length;
    let budget = 20_000_000;
    const maskOf = (v: number): number => {
      let m = 0;
      const h0 = first[v];
      let h = h0;
      do {
        const cw = color[to[h]];
        if (cw < 4) m |= 1 << cw;
        h = nxt[h];
      } while (h !== h0);
      return m;
    };
    const popcnt = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
    const rec = (left: number): boolean => {
      if (left === 0) return true;
      if (--budget < 0) throw new Error('総当たりフォールバックが打ち切られました');
      let best = -1, bestSat = -1, bestMask = 0;
      for (const v of verts) {
        if (color[v] < 4) continue;
        const m = maskOf(v);
        const s = popcnt[m] * 64 + Math.min(deg[v], 63);
        if (s > bestSat) {
          bestSat = s;
          best = v;
          bestMask = m;
          if (m === 15) return false;
        }
      }
      for (let c = 0; c < 4; c++) {
        if (bestMask & (1 << c)) continue;
        color[best] = c;
        if (rec(left - 1)) return true;
      }
      color[best] = UNCOLORED;
      return false;
    };
    if (!rec(verts.length)) throw new Error('4 彩色できません(入力が平面グラフではない可能性)');
  }

  // ------------------------------------------------------------------
  // 復元: レベルを逆順に戻し、Kempe 変更でリングの彩色を 0-extendible にして本体を塗る
  // ------------------------------------------------------------------

  extendAll(): void {
    const tri = this.tri;
    const configs = this.lib.configs;
    const pa = this.pool.a;
    for (let L = this.levelStart.len - 1; L >= 0; L--) {
      const s = this.levelStart.a[L];
      const e = L + 1 < this.levelStart.len ? this.levelStart.a[L + 1] : this.occCfg.len;
      let firstMerge = e;
      for (let o = e - 1; o >= s; o--) {
        const mg = this.occMerge.a[o];
        if (mg >= 0) {
          firstMerge = o;
          // 同一視を解く: つぶしていた頂点は相手と同じ色
          const mp = this.mergePool.a;
          const c = tri.unidentify(mp, mg);
          this.color[c] = this.color[tri.to[tri.twin[mp[mg]]]];
        }
        tri.popEdges(this.occHe.a[o]);
        const c = configs[this.occCfg.a[o]];
        const base = this.occImg.a[o] + c.R;
        for (let j = c.S - 1; j >= 0; j--) tri.restoreVertex(pa[base + j]);
      }
      // 同一視のあとで採用した配置は、リングの像に「同一視後の頂点」を記録している。
      // 同一視を解いたいまのグラフでのリング頂点に取り直す。
      for (let o = firstMerge + 1; o < e; o++) this.refreshRing(o);
      this.extendLevel(s, e);
    }
  }

  /** 配置の出現 o のリングの像を、現在のグラフの構造から読み直す。 */
  private refreshRing(o: number): void {
    const ci = this.occCfg.a[o];
    if (ci === 0 || this.occMerge.a[o] >= 0) return; // すぐ塗れるものは不要
    const { to, nxt, prv, first } = this.tri;
    const pa = this.pool.a;
    const off = this.occImg.a[o];
    if (ci === 1) {
      let h = first[pa[off + 4]];
      for (let i = 0; i < 4; i++) {
        pa[off + i] = to[h];
        h = nxt[h];
      }
      return;
    }
    const c = this.lib.configs[ci];
    const { R, S, deg, rot } = c;
    const step = this.occDir.a[o] ? prv : nxt;
    for (let j = 0; j < S; j++) {
      const d = deg[j];
      // 本体の隣接点(像は変わらない)を 1 つ選んで向きを合わせる
      let i0 = 0;
      while (rot[j * MAX_DEG + i0] < R) i0++;
      const target = pa[off + rot[j * MAX_DEG + i0]];
      const h0 = first[pa[off + R + j]];
      let h = h0;
      while (to[h] !== target) {
        h = nxt[h];
        if (h === h0) throw new Error('refreshRing: lost interior neighbour');
      }
      for (let t = 0; t < d; t++) {
        let pos = i0 + t;
        if (pos >= d) pos -= d;
        const w = rot[j * MAX_DEG + pos];
        if (w < R) pa[off + w] = to[h];
        h = step[h];
      }
    }
  }

  private tryExtendOcc(o: number): boolean {
    const c = this.lib.configs[this.occCfg.a[o]];
    const off = this.occImg.a[o];
    const pa = this.pool.a, color = this.color;
    const R = c.R;
    const rc = this.ringCol;
    for (let i = 0; i < R; i++) rc[i] = color[pa[off + i]];
    if (!tryExtend(c, rc, this.extOut)) return false;
    for (let j = 0; j < c.S; j++) color[pa[off + R + j]] = this.extOut[j];
    return true;
  }

  private extendLevel(s: number, e: number): void {
    let stuck: Int32Array | null = null;
    let ns = 0;
    for (let o = s; o < e; o++) {
      if (this.tryExtendOcc(o)) continue;
      if (!stuck) stuck = new Int32Array(e - o);
      stuck[ns++] = o;
    }
    if (!stuck) return;
    const fails = new Uint8Array(ns);
    const budget = new Int32Array(ns).fill(BUDGET0);
    const random = this.opts.kempeMode === 'random';
    let passes = 0;
    let lastP = -1;
    let lastProgress = true;
    while (ns > 0) {
      if (++passes > 1_000_000) throw new Error('Kempe 変更が収束しません');
      const p = random ? this.rand() % 3 : this.choosePairing(stuck, ns, lastP, lastProgress);
      this.kempePass(p, stuck, fails, budget, ns, random);
      let m = 0;
      for (let i = 0; i < ns; i++) {
        if (this.tryExtendOcc(stuck[i])) continue;
        stuck[m] = stuck[i];
        fails[m] = fails[i];
        budget[m] = budget[i];
        m++;
      }
      lastProgress = m < ns;
      lastP = p;
      ns = m;
    }
    this.stats.kempePasses += passes;
    if (passes > this.stats.maxPassesPerLevel) this.stats.maxPassesPerLevel = passes;
  }

  /** 次数 4 の単独頂点 (リングが 4 色) を直せる唯一の組分け: 向かい合う 2 頂点の色を組にするもの */
  private wantedPairing(o: number): number {
    const off = this.occImg.a[o];
    const x = this.color[this.pool.a[off]], y = this.color[this.pool.a[off + 2]];
    return x === 0 ? y - 1 : y === 0 ? x - 1 : 5 - x - y;
  }

  /** 色の組分け p: {0, p+1} と残りの 2 色。次数 4 の単独頂点の「欲しい組分け」の多数決で選ぶ。 */
  private choosePairing(stuck: Int32Array, ns: number, lastP: number, lastProgress: boolean): number {
    const votes = [0, 0, 0];
    let others = 0;
    for (let i = 0; i < ns; i++) {
      const o = stuck[i];
      if (this.occCfg.a[o] === 1) votes[this.wantedPairing(o)]++;
      else others++;
    }
    let p = 0;
    if (votes[1] > votes[p]) p = 1;
    if (votes[2] > votes[p]) p = 2;
    // D の配置しか残っていない、または同じ組分けで進展がなかったときは順に回す
    if (votes[p] === 0 || votes[p] * 4 < others || (p === lastP && !lastProgress)) p = (lastP + 1) % 3;
    return p;
  }

  private growLists(): void {
    const cap = this.lFirst.length * 2;
    const gi = (a: Int32Array): Int32Array<ArrayBuffer> => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.lFirst = gi(this.lFirst);
    this.lHead = gi(this.lHead);
    this.lTail = gi(this.lTail);
    this.lLastExp = gi(this.lLastExp);
    this.lSize = gi(this.lSize);
    const st = new Uint8Array(cap);
    st.set(this.lState);
    this.lState = st;
    const de = new Int8Array(cap);
    de.set(this.lDec);
    this.lDec = de;
  }

  private newList(v: number): number {
    const id = this.lc++;
    if (id === this.lFirst.length) this.growLists();
    this.lFirst[id] = v;
    this.lHead[id] = v;
    this.lTail[id] = v;
    this.lLastExp[id] = -1;
    this.lSize[id] = 1;
    this.lState[id] = PARTIAL;
    this.lDec[id] = -1;
    this.compStamp[v] = this.passStamp;
    this.compId[v] = id;
    this.qnext[v] = -1;
    this.stats.kempeExplored++;
    return id;
  }

  /** 探索途中のリスト a, b(同じ Kempe 鎖だと分かった)を併合し、残る側の id を返す。 */
  private mergeLists(a: number, b: number): number {
    const big = this.lSize[a] >= this.lSize[b] ? a : b;
    const small = big === a ? b : a;
    const qnext = this.qnext, compId = this.compId;
    for (let v = this.lFirst[small]; v >= 0; v = qnext[v]) compId[v] = big;
    // 連結順: 展開済み(big) → 展開済み(small) → 未展開(big) → 未展開(small)
    let first = -1, last = -1;
    const eb = this.lLastExp[big], es = this.lLastExp[small];
    const hb = this.lHead[big], hs = this.lHead[small];
    const fb = this.lFirst[big], fs = this.lFirst[small];
    const tb = this.lTail[big], ts = this.lTail[small];
    if (eb >= 0) {
      first = fb;
      last = eb;
    }
    if (es >= 0) {
      if (first < 0) first = fs;
      else qnext[last] = fs;
      last = es;
    }
    if (hb >= 0) {
      if (first < 0) first = hb;
      else qnext[last] = hb;
      last = tb;
    }
    if (hs >= 0) {
      if (first < 0) first = hs;
      else qnext[last] = hs;
      last = ts;
    }
    qnext[last] = -1;
    this.lFirst[big] = first;
    this.lLastExp[big] = es >= 0 ? es : eb;
    this.lHead[big] = hb >= 0 ? hb : hs;
    this.lTail[big] = last;
    this.lSize[big] += this.lSize[small];
    this.lState[small] = MERGED;
    return big;
  }

  /**
   * リスト id の Kempe 鎖を最大 quantum 頂点ぶん幅優先で伸ばす。
   * 併合で id が変わることがあるので、現在の id を返す。状態は lState で見る。
   */
  private expand(id: number, quantum: number): number {
    const { to, nxt, first } = this.tri;
    const color = this.color, cls = this.cls;
    const compId = this.compId, compStamp = this.compStamp, qnext = this.qnext;
    const lState = this.lState;
    const ps = this.passStamp;
    const cl = cls[color[this.lFirst[id]]];
    // リストの先頭/末尾はローカル変数で持ち、併合の前後と終了時にだけ書き戻す
    let head = this.lHead[id], tail = this.lTail[id], lastExp = this.lLastExp[id];
    let grown = 0;
    let frozen = false;
    scan: for (let cnt = 0; cnt < quantum && head >= 0; cnt++) {
      const x = head;
      head = qnext[x];
      lastExp = x;
      const h0 = first[x];
      let h = h0;
      do {
        const w = to[h];
        if (cls[color[w]] === cl) {
          if (compStamp[w] !== ps) {
            compStamp[w] = ps;
            compId[w] = id;
            qnext[w] = -1;
            qnext[tail] = w;
            tail = w;
            if (head < 0) head = w;
            grown++;
          } else {
            const o = compId[w];
            if (o !== id) {
              if (lState[o] === FROZEN) {
                frozen = true;
                break scan;
              }
              this.lHead[id] = head;
              this.lTail[id] = tail;
              this.lLastExp[id] = lastExp;
              this.lSize[id] += grown;
              this.stats.kempeExplored += grown;
              grown = 0;
              id = this.mergeLists(id, o);
              head = this.lHead[id];
              tail = this.lTail[id];
              lastExp = this.lLastExp[id];
            }
          }
        }
        h = nxt[h];
      } while (h !== h0);
    }
    this.lHead[id] = head;
    this.lTail[id] = tail;
    this.lLastExp[id] = lastExp;
    this.lSize[id] += grown;
    this.stats.kempeExplored += grown;
    if (frozen) lState[id] = FROZEN;
    else if (head < 0) lState[id] = COMPLETE;
    return id;
  }

  /**
   * 1 回の(大域的な)Kempe 変更。組分け p の 2 色成分(Kempe 鎖)のうち未彩色リングに触れるものについて
   * swap するかどうかを決め、最後にまとめて入れ替える。
   *
   * 鎖は 1 本が線形サイズになりうるので、リングごとに触れている鎖を少しずつ同時に伸ばし、
   * 探索し終えた(=小さい)鎖だけで直せる swap の組合せが見つかった時点で打ち切る。
   * 打ち切った鎖は「このパスでは swap しない」と確定させる。
   */
  private kempePass(p: number, stuck: Int32Array, fails: Uint8Array, budget: Int32Array, ns: number, random: boolean): void {
    const cls = this.cls, partner = this.partner;
    const q = p + 1;
    const r1 = q === 1 ? 2 : 1, r2 = q === 3 ? 2 : 3;
    cls[0] = 0; cls[q] = 0; cls[r1] = 1; cls[r2] = 1; cls[UNCOLORED] = 2;
    partner[0] = q; partner[q] = 0; partner[r1] = r2; partner[r2] = r1;
    this.passStamp++;
    this.lc = 0;
    const configs = this.lib.configs;
    const pa = this.pool.a, color = this.color;
    const compId = this.compId, compStamp = this.compStamp;
    const ps = this.passStamp;
    const act = this.act;
    const shift = ns > 1 ? this.rand() % ns : 0;

    for (let s0 = 0; s0 < ns; s0++) {
      let si = s0 + shift;
      if (si >= ns) si -= ns;
      const o = stuck[si];
      const ci = this.occCfg.a[o];
      // 次数 4 の単独頂点は、向かい合う頂点の色を組にする組分けでしか直せない
      const perturb = !random && ci === 1 && this.wantedPairing(o) !== p;
      // 欲しい組分けで一度も失敗していないなら、他の組分けのパスでは何もしない
      if (perturb && fails[si] === 0) continue;
      const c = configs[ci];
      const off = this.occImg.a[o];
      const R = c.R;
      let na = 0;
      for (let i = 0; i < R; i++) {
        const v = pa[off + i];
        if (compStamp[v] !== ps) act[na++] = this.newList(v);
      }
      if (perturb) {
        // 欲しい組分けでは大きな鎖しかなく直せなかった頂点: 別の組分けで小さな鎖を 1 本 swap して
        // リングの彩色を変え、次のパスで別の鎖に賭ける(リングは 4 色のままだが欲しい組分けが変わる)
        this.perturbSingle(off, na);
        continue;
      }
      if (random) {
        // 論文 3.1 節どおり: 鎖をすべて求め、それぞれ確率 1/2 で swap する
        for (let i = 0; i < na; i++) {
          if (this.lState[act[i]] !== PARTIAL) continue;
          const id = this.expand(act[i], 0x7fffffff);
          this.lDec[id] = this.rand() & 1;
        }
        continue;
      }
      this.testsLeft = PATTERN_LIMIT;
      const startExplored = this.stats.kempeExplored;
      const limit = budget[si];
      let found = false;
      let over = false;
      let dirty = true;
      let quantum = QUANTUM0;
      for (;;) {
        if (dirty) {
          found = this.testRing(c, off);
          if (found) break;
          dirty = false;
        }
        let anyActive = false;
        for (let i = 0; i < na; i++) {
          let id = act[i];
          if (this.lState[id] !== PARTIAL) continue;
          id = this.expand(id, quantum);
          const st = this.lState[id];
          if (st === PARTIAL) anyActive = true;
          else if (st === COMPLETE) dirty = true;
        }
        if (!anyActive) {
          if (dirty) found = this.testRing(c, off);
          break;
        }
        if (this.stats.kempeExplored - startExplored > limit) {
          if (dirty) found = this.testRing(c, off);
          over = true;
          break;
        }
        quantum *= 2;
      }
      // 探索途中の鎖は swap しないものとして確定する
      for (let i = 0; i < na; i++) if (this.lState[act[i]] === PARTIAL) this.lState[act[i]] = FROZEN;
      if (found) {
        const loc = this.loc, und = this.und, fl = this.flipLoc;
        for (let u = 0; u < this.nu; u++) this.lDec[loc[und[u]]] = fl[und[u]];
        fails[si] = 0;
      } else {
        if (fails[si] < 255) fails[si]++;
        // 予算は「組分けを一巡しても直らなかった」ときにだけ増やす
        if (over && budget[si] < 0x20000000 && fails[si] % (ci === 1 ? GROW_SINGLE : GROW_D) === 0) budget[si] *= 2;
        // 1 手では直せない D の配置のリング: 論文 3.1 節と同じくランダムな swap で揺さぶる
        if (ci >= 2 && fails[si] >= PERTURB_AFTER) {
          this.gatherRing(c, off);
          for (let u = 0; u < this.nu; u++) this.lDec[this.loc[this.und[u]]] = this.rand() & 1;
        }
      }
    }

    // swap の実行
    const qnext = this.qnext;
    let flipped = 0;
    for (let id = 0; id < this.lc; id++) {
      if (this.lState[id] !== COMPLETE || this.lDec[id] !== 1) continue;
      for (let v = this.lFirst[id]; v >= 0; v = qnext[v]) color[v] = partner[color[v]];
      flipped += this.lSize[id];
    }
    this.stats.kempeFlipped += flipped;
  }

  /** 次数 4 の単独頂点のリングに触れる鎖のうち、小さいものを 1 本だけ swap と決める。 */
  private perturbSingle(off: number, na: number): void {
    const act = this.act;
    const pa = this.pool.a, compId = this.compId;
    let quantum = QUANTUM0;
    let spent = 0;
    let done = false;
    while (!done && spent < BUDGET0) {
      let anyActive = false;
      for (let i = 0; i < na; i++) {
        let id = act[i];
        if (this.lState[id] !== PARTIAL) continue;
        id = this.expand(id, quantum);
        if (this.lState[id] === PARTIAL) anyActive = true;
        else if (this.lState[id] === COMPLETE) done = true;
      }
      spent += quantum * na;
      if (!anyActive) break;
      quantum *= 2;
    }
    for (let i = 0; i < na; i++) if (this.lState[act[i]] === PARTIAL) this.lState[act[i]] = FROZEN;
    // リング頂点の鎖のうち、探索済みで未決定のものを 1 本 swap する
    const start = this.rand() & 3;
    for (let k = 0; k < 4; k++) {
      const id = compId[pa[off + ((start + k) & 3)]];
      if (this.lState[id] === COMPLETE && this.lDec[id] < 0) {
        this.lDec[id] = 1;
        return;
      }
    }
  }

  /**
   * リングの各頂点が属する鎖を集める。
   * loc[] = リングに触れる相異なる鎖, ringLoc[i] = リング i 番目の鎖の loc 内位置,
   * und[0..nu) = 探索済みで swap 未決定の鎖, flipLoc[l] = すでに swap と決まっているか。
   * 戻り値: すでに swap が決まっている鎖があるか。
   */
  private gatherRing(c: Config, off: number): boolean {
    const R = c.R;
    const pa = this.pool.a, color = this.color, compId = this.compId;
    const rc = this.ringCol, rl = this.ringLoc, loc = this.loc, und = this.und, fl = this.flipLoc;
    let nl = 0;
    for (let i = 0; i < R; i++) {
      const v = pa[off + i];
      rc[i] = color[v];
      const id = compId[v];
      let l = 0;
      while (l < nl && loc[l] !== id) l++;
      if (l === nl) loc[nl++] = id;
      rl[i] = l;
    }
    let nu = 0;
    let anyFlip = false;
    for (let l = 0; l < nl; l++) {
      const id = loc[l];
      fl[l] = 0;
      if (this.lState[id] !== COMPLETE) continue;
      const d = this.lDec[id];
      if (d < 0) und[nu++] = l;
      else if (d === 1) {
        fl[l] = 1;
        anyFlip = true;
      }
    }
    this.nu = nu;
    return anyFlip;
  }

  /** 探索済みの鎖の swap だけでリングを 0-extendible にできるか調べる。成功時 flipLoc に答えが残る。 */
  private testRing(c: Config, off: number): boolean {
    const anyFlip = this.gatherRing(c, off);
    const R = c.R, nu = this.nu;
    if (anyFlip && this.testPattern(c, R, 0, nu)) return true;
    if (nu === 0) return false;
    if (nu <= 5) {
      for (let mask = 1, lim = 1 << nu; mask < lim; mask++) {
        if (this.testPattern(c, R, mask, nu)) return true;
      }
      return false;
    }
    for (let b = 0; b < nu && this.testsLeft > 0; b++) {
      this.testsLeft--;
      if (this.testPattern(c, R, 1 << b, nu)) return true;
    }
    const lim = nu >= 31 ? 0x7fffffff : (1 << nu) - 1;
    for (let t = 0; t < 16 && this.testsLeft > 0; t++) {
      this.testsLeft--;
      if (this.testPattern(c, R, 1 + (this.rand() % lim), nu)) return true;
    }
    return false;
  }

  /** 未決定の鎖に mask を当てはめたときのリング彩色が 0-extendible か。 */
  private testPattern(c: Config, R: number, mask: number, nu: number): boolean {
    const fl = this.flipLoc, und = this.und, rc = this.ringCol, rt = this.ringTry, rl = this.ringLoc;
    const partner = this.partner;
    for (let u = 0; u < nu; u++) fl[und[u]] = (mask >> u) & 1;
    for (let i = 0; i < R; i++) rt[i] = fl[rl[i]] ? partner[rc[i]] : rc[i];
    return tryExtend(c, rt, this.extOut);
  }
}

export function solveWithLibrary(lib: ConfigLibrary, g: RotationSystem, opts: SolveOptions = {}): SolveResult {
  const t0 = performance.now();
  const n = g.n;
  const stats = emptyStats(n, g.neighbors.length / 2);
  if (n <= 4) {
    const colors = new Uint8Array(n);
    for (let i = 0; i < n; i++) colors[i] = i;
    stats.msTotal = performance.now() - t0;
    return { colors, stats };
  }
  const tri = Tri.fromRotation(g);
  stats.triangulationEdges = tri.triangulateAll();
  const t1 = performance.now();
  stats.msTriangulate = t1 - t0;
  const run = new Run(lib, tri, stats, opts);
  run.reduce();
  const t2 = performance.now();
  stats.msReduce = t2 - t1;
  run.colorBase();
  run.extendAll();
  const t3 = performance.now();
  stats.msExtend = t3 - t2;
  const colors = run.color;
  if (opts.verify) {
    verifyColoring(g, colors);
    if (run.rescued > 0) throw new Error(`dirty tracking missed ${run.rescued} level(s)`);
  }
  stats.msTotal = performance.now() - t0;
  return { colors, stats };
}

export function verifyColoring(g: RotationSystem, colors: Uint8Array): void {
  for (let u = 0; u < g.n; u++) {
    if (colors[u] > 3) throw new Error(`vertex ${u} is not coloured`);
    for (let s = g.offsets[u], e = g.offsets[u + 1]; s < e; s++) {
      if (colors[g.neighbors[s]] === colors[u]) throw new Error(`edge ${u}-${g.neighbors[s]} is monochromatic`);
    }
  }
}
