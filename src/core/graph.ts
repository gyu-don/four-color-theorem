import type { RotationSystem } from './types';

/**
 * 動的な平面グラフ(半辺 + rotation system)。
 *
 * - 半辺 h の相方は twin[h]。h の終点は to[h]、始点は to[twin[h]]。
 *   入力の辺については、同じ頂点から出る半辺の id が連続するように振る(走査の局所性のため)。
 * - nxt[h] / prv[h] は始点まわりの巡回順での次/前の半辺。
 * - 半辺 h = (u→w) の「左の面」は u の角 (h, nxt[h]) を含む面で、面を一周するには
 *   faceNext(h) = prv[twin[h]] をたどる。三角形分割なら to[nxt[h]] がその面の第 3 頂点。
 *
 * 頂点の削除は dancing links 方式(自分のリストは保ったまま相手側のリストから外す)なので、
 * 削除の逆順に restore すれば完全に元へ戻る。追加した辺は後入れ先出しで取り除く。
 */
export class Tri {
  readonly n: number;
  to: Int32Array;
  twin: Int32Array;
  nxt: Int32Array;
  prv: Int32Array;
  readonly first: Int32Array;
  readonly deg: Int32Array;
  readonly alive: Uint8Array;
  /** 確保済み半辺数(常に偶数) */
  heCount = 0;
  /** 生きている頂点数 */
  live: number;

  constructor(n: number, heCapacity: number) {
    this.n = n;
    this.live = n;
    const cap = Math.max(16, heCapacity);
    this.to = new Int32Array(cap);
    this.twin = new Int32Array(cap);
    this.nxt = new Int32Array(cap);
    this.prv = new Int32Array(cap);
    this.first = new Int32Array(n).fill(-1);
    this.deg = new Int32Array(n);
    this.alive = new Uint8Array(n).fill(1);
  }

  /** rotation system から構築する。グラフは単純であること。 */
  static fromRotation(g: RotationSystem): Tri {
    const { n, offsets, neighbors } = g;
    const slots = neighbors.length;
    // 三角形分割で増える辺 + 縮約時の補助辺のぶんを見込んで確保する
    const t = new Tri(n, Math.max(slots, 6 * n) * 2 + 64);
    const to = t.to, twin = t.twin, nxt = t.nxt, prv = t.prv;
    // 半辺 id = スロット番号。相方は「小さい側から来たスロット」を頂点ごとに溜めておいて対応づける。
    const pendHead = new Int32Array(n).fill(-1);
    const pendNext = new Int32Array(slots);
    const owner = new Int32Array(slots);
    const mark = new Int32Array(n).fill(-1);
    let paired = 0;
    for (let u = 0; u < n; u++) {
      for (let s = pendHead[u]; s !== -1; s = pendNext[s]) mark[owner[s]] = s;
      const s0 = offsets[u], e = offsets[u + 1];
      const d = e - s0;
      t.deg[u] = d;
      if (d > 0) t.first[u] = s0;
      for (let s = s0; s < e; s++) {
        const w = neighbors[s];
        if (w === u) throw new Error('loop in input graph');
        to[s] = w;
        nxt[s] = s + 1 < e ? s + 1 : s0;
        prv[s] = s > s0 ? s - 1 : e - 1;
        if (w > u) {
          owner[s] = u;
          pendNext[s] = pendHead[w];
          pendHead[w] = s;
        } else {
          const ms = mark[w];
          if (ms < 0) throw new Error('rotation system is not symmetric or has parallel edges');
          mark[w] = -1;
          twin[s] = ms;
          twin[ms] = s;
          paired += 2;
        }
      }
    }
    if (paired !== slots) throw new Error('rotation system is not symmetric');
    t.heCount = slots;
    return t;
  }

  private grow(): void {
    const cap = this.to.length * 2;
    const g = (a: Int32Array) => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.to = g(this.to);
    this.twin = g(this.twin);
    this.nxt = g(this.nxt);
    this.prv = g(this.prv);
  }

  /** u と w が隣接しているか(次数の小さい側を走査)。 */
  adjacent(u: number, w: number): boolean {
    const deg = this.deg;
    if (deg[u] > deg[w]) {
      const x = u;
      u = w;
      w = x;
    }
    const h0 = this.first[u];
    if (h0 < 0) return false;
    const to = this.to, nxt = this.nxt;
    let h = h0;
    do {
      if (to[h] === w) return true;
      h = nxt[h];
    } while (h !== h0);
    return false;
  }

  /**
   * 辺を追加する。新しい半辺 c=(u→w) は afterU の直後、相方 (w→u) は afterW の直後に入る。
   * afterU の始点が u、afterW の始点が w であること。戻り値は c。
   */
  addEdge(afterU: number, afterW: number): number {
    if (this.heCount + 2 > this.to.length) this.grow();
    const to = this.to, twin = this.twin, nxt = this.nxt, prv = this.prv;
    const u = to[twin[afterU]], w = to[twin[afterW]];
    const c = this.heCount;
    const d = c + 1;
    this.heCount += 2;
    to[c] = w;
    to[d] = u;
    twin[c] = d;
    twin[d] = c;
    let x = nxt[afterU];
    nxt[afterU] = c; prv[c] = afterU; nxt[c] = x; prv[x] = c;
    x = nxt[afterW];
    nxt[afterW] = d; prv[d] = afterW; nxt[d] = x; prv[x] = d;
    this.deg[u]++;
    this.deg[w]++;
    return c;
  }

  /** 半辺 h を始点のリストから外す(h 自身のリンクは残す)。 */
  private unlink(h: number): void {
    const nxt = this.nxt, prv = this.prv;
    const o = this.to[this.twin[h]];
    const p = prv[h], q = nxt[h];
    nxt[p] = q;
    prv[q] = p;
    if (--this.deg[o] === 0) this.first[o] = -1;
    else if (this.first[o] === h) this.first[o] = q;
  }

  private relink(h: number): void {
    const nxt = this.nxt, prv = this.prv;
    const o = this.to[this.twin[h]];
    nxt[prv[h]] = h;
    prv[nxt[h]] = h;
    if (this.deg[o]++ === 0) this.first[o] = h;
  }

  /** 最後に追加した辺から順に、半辺 id が heBefore 以上のものをすべて取り除く。 */
  popEdges(heBefore: number): void {
    for (let h = this.heCount - 2; h >= heBefore; h -= 2) {
      this.unlink(h + 1);
      this.unlink(h);
    }
    this.heCount = heBefore;
  }

  /**
   * 四角形の面 (a, b, c, d) をつぶして c を a に同一視する(a, c は面の向かい合う頂点)。
   * hb = (a→b) で、面は hb の左にあること(nxt[hb] = (a→d))。
   * a と c は非隣接で、b, d 以外に共通の隣接点を持たないこと(呼び出し側で確かめる)。
   * 巻き戻し用の記録 7 個を rec[off..off+7) に書く。
   */
  identify(hb: number, rec: Int32Array, off: number): void {
    const { to, twin, nxt, prv } = this;
    const hd = nxt[hb];
    const ebc = prv[twin[hb]]; // (b→c)
    const cb = twin[ebc]; // (c→b)
    const cd = prv[cb]; // (c→d)
    const a = to[twin[hb]], c = to[ebc];
    let x1 = nxt[cb];
    let xk = prv[cd];
    let k = 0;
    if (x1 === cd) {
      x1 = -1;
      xk = -1;
    }
    // b, d との重複する辺 (c 側) を外す
    this.unlink(cb);
    this.unlink(ebc);
    this.unlink(cd);
    this.unlink(twin[cd]);
    if (x1 >= 0) {
      for (let h = x1; ; h = nxt[h]) {
        to[twin[h]] = a;
        k++;
        if (h === xk) break;
      }
      nxt[hb] = x1;
      prv[x1] = hb;
      nxt[xk] = hd;
      prv[hd] = xk;
      this.deg[a] += k;
    }
    this.alive[c] = 0;
    this.live--;
    rec[off] = hb;
    rec[off + 1] = hd;
    rec[off + 2] = cb;
    rec[off + 3] = cd;
    rec[off + 4] = x1;
    rec[off + 5] = xk;
    rec[off + 6] = k;
  }

  /** identify の逆操作。つぶしていた頂点 c を返す(相手の a は to[twin[rec[off]]])。 */
  unidentify(rec: Int32Array, off: number): number {
    const { to, twin, nxt, prv } = this;
    const hb = rec[off], hd = rec[off + 1], cb = rec[off + 2], cd = rec[off + 3];
    const x1 = rec[off + 4], xk = rec[off + 5], k = rec[off + 6];
    const ebc = twin[cb];
    const c = to[ebc];
    if (x1 >= 0) {
      const a = to[twin[hb]];
      nxt[hb] = hd;
      prv[hd] = hb;
      this.deg[a] -= k;
      // first[a] が c から来た半辺を指しているかもしれないので、a 自身の半辺に戻す
      this.first[a] = hb;
      // c のリストを、2 本の辺を外した直後の状態(x1..xk の輪)に戻す
      prv[x1] = xk;
      nxt[xk] = x1;
      for (let h = x1; ; h = nxt[h]) {
        to[twin[h]] = c;
        if (h === xk) break;
      }
    }
    this.relink(twin[cd]);
    this.relink(cd);
    this.relink(ebc);
    this.relink(cb);
    this.alive[c] = 1;
    this.live++;
    return c;
  }

  /** 頂点 v を取り除く(隣接点のリストから v への半辺を外す)。 */
  removeVertex(v: number): void {
    const h0 = this.first[v];
    if (h0 >= 0) {
      const nxt = this.nxt, twin = this.twin;
      let h = h0;
      do {
        this.unlink(twin[h]);
        h = nxt[h];
      } while (h !== h0);
    }
    this.alive[v] = 0;
    this.live--;
  }

  /** removeVertex の逆操作。削除の逆順で呼ぶこと。 */
  restoreVertex(v: number): void {
    const h0 = this.first[v];
    if (h0 >= 0) {
      const prv = this.prv, twin = this.twin;
      let h = prv[h0];
      const last = h;
      do {
        this.relink(twin[h]);
        h = prv[h];
      } while (h !== last);
    }
    this.alive[v] = 1;
    this.live++;
  }

  /**
   * 面を、多重辺を作らない弦で三角形に分割する(耳切り)。
   * face は面の境界の半辺列 e_0..e_{k-1}(e_i の終点 = e_{i+1} の始点、面は各 e_i の左)。
   * 境界に同じ頂点が複数回現れてもよい。追加した弦の本数を返す。
   * face 配列は作業領域として書き換える。
   */
  triangulateFace(face: Int32Array, k: number, scratchNext: Int32Array, scratchPrev: Int32Array): number {
    if (k <= 3) return 0;
    const lnext = scratchNext, lprev = scratchPrev;
    for (let i = 0; i < k; i++) {
      lnext[i] = i + 1 < k ? i + 1 : 0;
      lprev[i] = i > 0 ? i - 1 : k - 1;
    }
    let size = k;
    let cur = 0;
    let fails = 0;
    let added = 0;
    while (size > 3) {
      const b = lnext[cur];
      const e0 = face[cur], e1 = face[b];
      const u = this.to[this.twin[e0]];
      const w = this.to[e1];
      if (u !== w && !this.adjacent(u, w)) {
        const c = lnext[b];
        // 弦 (u→w): u 側は e0 の直後、w 側は次の境界半辺 face[c](始点 w)の直後
        const ch = this.addEdge(e0, face[c]);
        added++;
        face[cur] = ch;
        lnext[cur] = c;
        lprev[c] = cur;
        size--;
        fails = 0;
        cur = c; // ジグザグに進めて特定の頂点に弦が集中しないようにする
      } else {
        cur = b;
        if (++fails > size) throw new Error('triangulateFace: no valid ear (graph is not a simple plane graph?)');
      }
    }
    return added;
  }

  /**
   * すべての面を三角形に分割する。入力は連結な単純平面グラフ(頂点 3 以上)。
   * 追加した辺の本数を返す。
   */
  triangulateAll(): number {
    const he0 = this.heCount;
    const seen = new Uint8Array(he0);
    let buf = new Int32Array(64);
    let sn = new Int32Array(64);
    let sp = new Int32Array(64);
    let added = 0;
    for (let h0 = 0; h0 < he0; h0++) {
      if (seen[h0]) continue;
      let k = 0;
      let h = h0;
      do {
        seen[h] = 1;
        if (k === buf.length) {
          const nb = new Int32Array(k * 2);
          nb.set(buf);
          buf = nb;
          sn = new Int32Array(k * 2);
          sp = new Int32Array(k * 2);
        }
        buf[k++] = h;
        h = this.prv[this.twin[h]];
      } while (h !== h0);
      if (k < 3) throw new Error('face of length < 3 (parallel edges or a graph with fewer than 3 vertices)');
      if (k > 3) added += this.triangulateFace(buf, k, sn, sp);
    }
    return added;
  }

  /** 検査用: 生きている部分が単純な三角形分割になっているかを調べる。 */
  checkTriangulation(): void {
    const { to, twin, nxt, prv, first, deg, alive, n } = this;
    let vcount = 0, hcount = 0;
    const mark = new Int32Array(n).fill(-1);
    for (let v = 0; v < n; v++) {
      if (!alive[v]) continue;
      vcount++;
      const h0 = first[v];
      if (h0 < 0) throw new Error(`vertex ${v} isolated`);
      let h = h0, d = 0;
      do {
        if (twin[twin[h]] !== h || to[twin[h]] !== v) throw new Error(`half-edge ${h} origin mismatch`);
        const w = to[h];
        if (!alive[w]) throw new Error(`edge to dead vertex ${v}->${w}`);
        if (w === v) throw new Error('loop');
        if (mark[w] === v) throw new Error(`parallel edge ${v}-${w}`);
        mark[w] = v;
        if (prv[nxt[h]] !== h) throw new Error('nxt/prv mismatch');
        // 左の面が三角形か
        const a = prv[twin[h]];
        const b = prv[twin[a]];
        if (prv[twin[b]] !== h) throw new Error(`face left of ${v}->${w} is not a triangle`);
        d++;
        h = nxt[h];
      } while (h !== h0);
      if (d !== deg[v]) throw new Error(`deg mismatch at ${v}: ${d} vs ${deg[v]}`);
      hcount += d;
    }
    if (vcount !== this.live) throw new Error('live count mismatch');
    if (vcount >= 3 && hcount !== 2 * (3 * vcount - 6)) {
      throw new Error(`edge count ${hcount / 2} != 3n-6 (n=${vcount})`);
    }
  }
}
