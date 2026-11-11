import { CONFIGS_GZ_B64 } from '../data/configs';
import type { Tri } from './graph';

/** 配置の内部頂点の最大次数(D では 12) */
export const MAX_DEG = 12;
/** 配置(リング込み)の最大頂点数 */
export const MAX_N = 40;

/**
 * 可約配置 (Z, δ) の free completion。
 * 頂点番号は 0..N-1 で、0..R-1 がリング(巡回順)、R..N-1 が配置本体の頂点。
 */
export interface Config {
  N: number;
  R: number;
  /** 本体の頂点数 N - R */
  S: number;
  /** 本体頂点 j (0..S-1) の次数 δ */
  deg: Uint8Array;
  /** rot[j*MAX_DEG + i]: 本体頂点 j の i 番目の隣接点(free completion の頂点番号、時計回り) */
  rot: Uint8Array;
  /** 拡張(本体の彩色)で塗る順番。値は本体頂点 j */
  extOrder: Uint8Array;
  /** 塗る順 k 番目の頂点のリング隣接点: extRing[extRingOff[k] .. extRingOff[k+1]) */
  extRingOff: Uint8Array;
  extRing: Uint8Array;
  /** 塗る順 k 番目の頂点の、先に塗られる本体隣接点(塗る順の位置) */
  extIntOff: Uint8Array;
  extInt: Uint8Array;
}

/** 照合プログラム: ある配置を、ある根から幅優先で展開する手順 */
interface Program {
  cfg: number;
  /** 発見順 k → 本体頂点 j */
  order: Uint8Array;
  /** 発見順 k の頂点について、基準半辺(親への辺。根は 0 番目の隣接点)が rot の何番目か */
  refPos: Uint8Array;
}

export interface ConfigLibrary {
  /** configs[0] = 次数 3 の単独頂点, configs[1] = 次数 4 の単独頂点, configs[2+i] = D の i 番目 */
  configs: Config[];
  programs: Program[];
  /** 根の次数 → トライの節 (-1 ならなし) */
  rootByDeg: Int32Array;
  /** 節 i の「問い合わせ」群: gStart[i] .. gStart[i+1] */
  gStart: Int32Array;
  /** 問い合わせ g: 発見順 gP[g] 番目の頂点の、基準半辺から gO[g] 個先の隣接点の次数を調べる */
  gP: Uint8Array;
  gO: Uint8Array;
  /** tab[gTab[g] + 次数 - 5] = 次の節 (-1 ならなし) */
  gTab: Int32Array;
  tab: Int32Array;
  termStart: Int32Array;
  termProg: Int32Array;
}

async function gunzipBase64(b64: string): Promise<Uint8Array> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function finishConfig(N: number, R: number, deg: Uint8Array, rot: Uint8Array): Config {
  const S = N - R;
  // 塗る順: すでに色が決まっている隣接点(リング + 先に選んだ本体頂点)が最も多い頂点から
  const chosen = new Uint8Array(S);
  const pos = new Int8Array(S).fill(-1);
  const extOrder = new Uint8Array(S);
  for (let k = 0; k < S; k++) {
    let best = -1, bestScore = -1;
    for (let j = 0; j < S; j++) {
      if (chosen[j]) continue;
      let score = 0;
      for (let i = 0; i < deg[j]; i++) {
        const w = rot[j * MAX_DEG + i];
        if (w < R || chosen[w - R]) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    chosen[best] = 1;
    pos[best] = k;
    extOrder[k] = best;
  }
  const extRingOff = new Uint8Array(S + 1);
  const extIntOff = new Uint8Array(S + 1);
  const ring: number[] = [];
  const int: number[] = [];
  for (let k = 0; k < S; k++) {
    const j = extOrder[k];
    for (let i = 0; i < deg[j]; i++) {
      const w = rot[j * MAX_DEG + i];
      if (w < R) ring.push(w);
      else if (pos[w - R] < k) int.push(pos[w - R]);
    }
    extRingOff[k + 1] = ring.length;
    extIntOff[k + 1] = int.length;
  }
  return { N, R, S, deg, rot, extOrder, extRingOff, extRing: Uint8Array.from(ring), extIntOff, extInt: Uint8Array.from(int) };
}

function singleVertexConfig(d: number): Config {
  const deg = new Uint8Array([d]);
  const rot = new Uint8Array(MAX_DEG);
  for (let i = 0; i < d; i++) rot[i] = i;
  return finishConfig(d + 1, d, deg, rot);
}

function parseConfigs(bytes: Uint8Array): Config[] {
  const count = bytes[0] | (bytes[1] << 8);
  const out: Config[] = [singleVertexConfig(3), singleVertexConfig(4)];
  let p = 2;
  for (let c = 0; c < count; c++) {
    const N = bytes[p++], R = bytes[p++];
    const S = N - R;
    if (N > MAX_N) throw new Error('configuration too large');
    const deg = new Uint8Array(S);
    const rot = new Uint8Array(S * MAX_DEG);
    for (let j = 0; j < S; j++) {
      const d = bytes[p++];
      if (d > MAX_DEG) throw new Error('configuration degree too large');
      deg[j] = d;
      for (let i = 0; i < d; i++) rot[j * MAX_DEG + i] = bytes[p++] - 1;
    }
    out.push(finishConfig(N, R, deg, rot));
  }
  if (p !== bytes.length) throw new Error('trailing bytes in configuration data');
  return out;
}

/** 本体頂点どうしの距離から、照合の根にする頂点を選ぶ。 */
function chooseRoots(c: Config): number[] {
  const { S, R, deg, rot } = c;
  const ecc = new Int32Array(S);
  const dist = new Int32Array(S);
  const queue = new Int32Array(S);
  for (let s = 0; s < S; s++) {
    dist.fill(-1);
    dist[s] = 0;
    let qh = 0, qt = 0;
    queue[qt++] = s;
    let far = 0;
    while (qh < qt) {
      const j = queue[qh++];
      far = dist[j];
      for (let i = 0; i < deg[j]; i++) {
        const w = rot[j * MAX_DEG + i];
        if (w >= R && dist[w - R] < 0) {
          dist[w - R] = dist[j] + 1;
          queue[qt++] = w - R;
        }
      }
    }
    if (qt !== S) throw new Error('configuration is not connected');
    ecc[s] = far;
  }
  let minEcc = 99;
  for (let s = 0; s < S; s++) if (ecc[s] < minEcc) minEcc = ecc[s];
  if (minEcc > 2) {
    // 半径 3 の例外的な配置: すべての頂点を根にして、変更箇所から距離 2 以内に必ず根が来るようにする
    return Array.from({ length: S }, (_, i) => i);
  }
  // 離心数 2 以下の頂点のうち次数が最大のもの(次数の大きい頂点ほど珍しく、照合が早く打ち切れる)
  let best = -1;
  for (let s = 0; s < S; s++) {
    if (ecc[s] > 2) continue;
    if (best < 0 || deg[s] > deg[best] || (deg[s] === deg[best] && ecc[s] < ecc[best])) best = s;
  }
  return [best];
}

interface BuildNode {
  children: Map<number, BuildNode>;
  terms: number[];
}

function compileProgram(c: Config, cfgIndex: number, root: number): { prog: Program; keys: number[] } {
  const { S, R, deg, rot } = c;
  const order = new Uint8Array(S);
  const refPos = new Uint8Array(S);
  const idx = new Int8Array(S).fill(-1);
  const keys: number[] = [];
  order[0] = root;
  idx[root] = 0;
  let cnt = 1;
  // 幅優先・オフセット昇順で展開する(配置どうしで問い合わせ列の接頭辞が共有されやすい)
  for (let k = 0; k < cnt; k++) {
    const j = order[k];
    const d = deg[j];
    for (let o = k === 0 ? 0 : 1; o < d; o++) {
      const w = rot[j * MAX_DEG + ((refPos[k] + o) % d)];
      if (w < R) continue;
      const wj = w - R;
      if (idx[wj] >= 0) continue;
      idx[wj] = cnt;
      order[cnt] = wj;
      let rp = -1;
      for (let i = 0; i < deg[wj]; i++) if (rot[wj * MAX_DEG + i] === j + R) rp = i;
      if (rp < 0) throw new Error('asymmetric configuration adjacency');
      refPos[cnt] = rp;
      keys.push((k << 8) | (o << 4) | deg[wj]);
      cnt++;
    }
  }
  if (cnt !== S) throw new Error('configuration is not connected');
  return { prog: { cfg: cfgIndex, order, refPos }, keys };
}

export async function loadConfigLibrary(): Promise<ConfigLibrary> {
  const configs = parseConfigs(await gunzipBase64(CONFIGS_GZ_B64));
  const programs: Program[] = [];
  const roots: (BuildNode | undefined)[] = [];
  let nodeCount = 0, childCount = 0, termCount = 0;
  const newNode = (): BuildNode => {
    nodeCount++;
    return { children: new Map(), terms: [] };
  };
  for (let ci = 2; ci < configs.length; ci++) {
    const c = configs[ci];
    for (const root of chooseRoots(c)) {
      const { prog, keys } = compileProgram(c, ci, root);
      const d0 = c.deg[root];
      let node: BuildNode = roots[d0] ?? (roots[d0] = newNode());
      for (const key of keys) {
        let ch: BuildNode | undefined = node.children.get(key);
        if (!ch) {
          ch = newNode();
          node.children.set(key, ch);
          childCount++;
        }
        node = ch;
      }
      node.terms.push(programs.length);
      termCount++;
      programs.push(prog);
    }
  }
  // 平坦化: 子を (親番号, オフセット) ごとにまとめ、次数で直接引ける表にする
  const termStart = new Int32Array(nodeCount + 1);
  const termProg = new Int32Array(termCount);
  const gStart = new Int32Array(nodeCount + 1);
  const gP: number[] = [];
  const gO: number[] = [];
  const gTab: number[] = [];
  const tab: number[] = [];
  const rootByDeg = new Int32Array(MAX_DEG + 1).fill(-1);
  const list: BuildNode[] = [];
  for (let d = 0; d <= MAX_DEG; d++) {
    const r = roots[d];
    if (r) {
      rootByDeg[d] = list.length;
      list.push(r);
    }
  }
  let te = 0;
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    gStart[i] = gP.length;
    termStart[i] = te;
    for (const t of node.terms) termProg[te++] = t;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    let lastPO = -1;
    for (const key of keys) {
      const po = key >> 4;
      if (po !== lastPO) {
        lastPO = po;
        gP.push(key >> 8);
        gO.push((key >> 4) & 15);
        gTab.push(tab.length);
        for (let k = 0; k < 8; k++) tab.push(-1);
      }
      const dg = key & 15;
      if (dg < 5 || dg > 12) throw new Error('unexpected degree in configuration');
      tab[tab.length - 8 + dg - 5] = list.length;
      list.push(node.children.get(key)!);
    }
  }
  if (list.length !== nodeCount || childCount + rootCount(roots) !== nodeCount) throw new Error('trie flattening mismatch');
  gStart[list.length] = gP.length;
  termStart[list.length] = te;
  return {
    configs, programs, rootByDeg, gStart,
    gP: Uint8Array.from(gP), gO: Uint8Array.from(gO), gTab: Int32Array.from(gTab), tab: Int32Array.from(tab),
    termStart, termProg,
  };
}

function rootCount(roots: (BuildNode | undefined)[]): number {
  let c = 0;
  for (const r of roots) if (r) c++;
  return c;
}

/**
 * リングの彩色 ringCol (長さ R, 値 0..3) を配置本体へ拡張する(0-extendible かの判定)。
 * 成功したら out[j] に本体頂点 j の色を入れて true を返す。
 */
const extBase = new Uint8Array(MAX_N);
const extAvail = new Uint8Array(MAX_N);
const extCol = new Uint8Array(MAX_N);
export function tryExtend(c: Config, ringCol: Uint8Array, out: Uint8Array): boolean {
  const S = c.S;
  const ring = c.extRing, ringOff = c.extRingOff, int = c.extInt, intOff = c.extIntOff;
  for (let k = 0; k < S; k++) {
    let m = 0;
    for (let i = ringOff[k], e = ringOff[k + 1]; i < e; i++) m |= 1 << ringCol[ring[i]];
    if (m === 15) return false;
    extBase[k] = m;
  }
  let k = 0;
  extAvail[0] = ~extBase[0] & 15;
  for (;;) {
    const a = extAvail[k];
    if (a === 0) {
      if (--k < 0) return false;
      continue;
    }
    const bit = a & -a;
    extAvail[k] = a ^ bit;
    extCol[k] = bit;
    if (k === S - 1) break;
    k++;
    let m = extBase[k];
    for (let i = intOff[k], e = intOff[k + 1]; i < e; i++) m |= extCol[int[i]];
    extAvail[k] = ~m & 15;
  }
  const order = c.extOrder;
  for (let i = 0; i < S; i++) {
    const b = extCol[i];
    out[order[i]] = b === 1 ? 0 : b === 2 ? 1 : b === 4 ? 2 : 3;
  }
  return true;
}

/**
 * 三角形分割の中から D の配置の出現を探す。
 * 本体の頂点はすべて相異なり次数が δ に一致し、リングの像は本体の像と交わらないことを確かめる
 * (リングの頂点どうしが一致することは許す)。
 */
export class Matcher {
  /** 見つかった出現の像: img[0..N) = free completion の頂点 → グラフの頂点 */
  readonly img = new Int32Array(MAX_N);
  /** 直近の matchAt で、塞がっていたために採用できなかった出現があったか */
  sawBlocked = false;
  /** 直近の matchAt が根から距離 2 の頂点の次数まで調べたか(false なら結果は距離 1 以内だけで決まった) */
  deep = false;

  private readonly ref = new Int32Array(MAX_N);
  private readonly slotBuf = new Int32Array(MAX_N * 16);
  private readonly slotCnt = new Uint8Array(MAX_N);
  /** 照合の向き(0: nxt 方向, 1: prv 方向)。matchAt が成功した直後は、その出現の向き */
  dir = 0;
  private readonly seen: Int32Array;
  private seenToken = 0;
  private blocked!: Int32Array;
  private blockStamp = 0;

  constructor(private readonly lib: ConfigLibrary, private readonly tri: Tri) {
    this.seen = new Int32Array(tri.n);
  }

  private slot(k: number, o: number): number {
    const buf = this.slotBuf;
    const base = k << 4;
    let c = this.slotCnt[k];
    if (c <= o) {
      const step = this.dir ? this.tri.prv : this.tri.nxt;
      let g = buf[base + c - 1];
      while (c <= o) {
        g = step[g];
        buf[base + c++] = g;
      }
      this.slotCnt[k] = c;
    }
    return buf[base + o];
  }

  /**
   * 頂点 v を根として配置を探す。採用できる出現(本体が blocked でないもの)が見つかれば
   * その配置番号を返し、像を img に入れる。なければ -1。
   */
  matchAt(v: number, blocked: Int32Array, blockStamp: number): number {
    const tri = this.tri;
    const d = tri.deg[v];
    this.sawBlocked = false;
    this.deep = false;
    if (d > MAX_DEG) return -1;
    const rootNode = this.lib.rootByDeg[d];
    if (rootNode < 0) return -1;
    this.blocked = blocked;
    this.blockStamp = blockStamp;
    const h0 = tri.first[v];
    let h = h0;
    do {
      for (let dir = 0; dir < 2; dir++) {
        this.dir = dir;
        this.ref[0] = h;
        this.slotBuf[0] = h;
        this.slotCnt[0] = 1;
        const r = this.walk(rootNode, 1);
        if (r >= 0) return r;
      }
      h = tri.nxt[h];
    } while (h !== h0);
    return -1;
  }

  private walk(node: number, depth: number): number {
    const lib = this.lib;
    for (let t = lib.termStart[node], te = lib.termStart[node + 1]; t < te; t++) {
      const r = this.terminal(lib.termProg[t]);
      if (r >= 0) return r;
    }
    const to = this.tri.to, deg = this.tri.deg;
    const gP = lib.gP, gO = lib.gO, gTab = lib.gTab, tab = lib.tab;
    for (let g = lib.gStart[node], ge = lib.gStart[node + 1]; g < ge; g++) {
      const p = gP[g];
      if (p > 0) this.deep = true;
      const he = this.slot(p, gO[g]);
      const dg = deg[to[he]];
      if (dg < 5 || dg > 12) continue;
      const child = tab[gTab[g] + dg - 5];
      if (child < 0) continue;
      const back = this.tri.twin[he];
      this.ref[depth] = back;
      this.slotBuf[depth << 4] = back;
      this.slotCnt[depth] = 1;
      const r = this.walk(child, depth + 1);
      if (r >= 0) return r;
    }
    return -1;
  }

  private terminal(progIndex: number): number {
    const prog = this.lib.programs[progIndex];
    const c = this.lib.configs[prog.cfg];
    const { S, R, deg, rot } = c;
    const to = this.tri.to, twin = this.tri.twin;
    const img = this.img, seen = this.seen;
    const order = prog.order, refPos = prog.refPos;
    const token = ++this.seenToken;
    let blockedHit = false;
    for (let k = 0; k < S; k++) {
      const gv = to[twin[this.ref[k]]];
      if (seen[gv] === token) return -1; // 本体の頂点が重なる
      seen[gv] = token;
      if (this.blocked[gv] === this.blockStamp) blockedHit = true;
      img[R + order[k]] = gv;
    }
    for (let i = 0; i < R; i++) img[i] = -1;
    for (let k = 0; k < S; k++) {
      const j = order[k];
      const d = deg[j];
      const rp = refPos[k];
      for (let o = 0; o < d; o++) {
        const x = to[this.slot(k, o)];
        let pos = rp + o;
        if (pos >= d) pos -= d;
        const w = rot[j * MAX_DEG + pos];
        if (w < R) {
          if (seen[x] === token) return -1; // リングが本体に食い込む
          if (img[w] < 0) img[w] = x;
          else if (img[w] !== x) return -1;
        } else if (img[w] !== x) {
          return -1;
        }
      }
    }
    if (blockedHit) {
      this.sawBlocked = true;
      return -1;
    }
    return prog.cfg;
  }
}
