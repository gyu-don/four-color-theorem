// 地図編集の純粋なロジック: ブラシ範囲のセル探索、同ラベル連結成分の探索、分割、元に戻す/やり直す。
// DOM 非依存。

import type { SiteGraph } from './nearest';

/** 伸長可能な Uint32 配列(ホットループで配列を確保しないため) */
class U32Buffer {
  data: Uint32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Uint32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = v;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.length);
  }
}

class I32Buffer {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Int32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = v;
  }
}

/**
 * セル隣接上の幅優先探索。訪問済みの印はスタンプ方式(呼び出しごとに番号を変える)で、
 * 探索のたびに配列を初期化しない。返す配列は次の呼び出しまで有効な内部バッファのビュー。
 */
export class CellWalker {
  private stamp: Int32Array;
  private cur = 0;
  private queue = new U32Buffer();

  constructor(private g: SiteGraph) {
    this.stamp = new Int32Array(g.numCells);
  }

  private nextStamp(): number {
    if (this.cur === 0x7fffffff) {
      this.stamp.fill(0);
      this.cur = 0;
    }
    return ++this.cur;
  }

  /**
   * start(中心 (cx,cy) の最近傍セル)から、サイトが半径 r の円内にあるセルを幅優先で集める。
   * start は常に含む。Delaunay 三角形分割では円内の点の誘導部分グラフは連結なので漏れはない。
   */
  brush(start: number, cx: number, cy: number, r: number): Uint32Array {
    const { points: pts, nbrOffsets: off, nbrs: nb } = this.g;
    const s = this.nextStamp();
    const stamp = this.stamp;
    const q = this.queue;
    q.length = 0;
    if (start < 0) return q.view();
    const r2 = r * r;
    stamp[start] = s;
    q.push(start);
    for (let k = 0; k < q.length; k++) {
      const c = q.data[k];
      for (let p = off[c], end = off[c + 1]; p < end; p++) {
        const d = nb[p];
        if (stamp[d] === s) continue;
        stamp[d] = s;
        const dx = pts[2 * d] - cx;
        const dy = pts[2 * d + 1] - cy;
        if (dx * dx + dy * dy <= r2) q.push(d);
      }
    }
    return q.view();
  }

  /** start と同じラベルを持ち、隣接で連結なセル全体(start を含む領域) */
  component(labels: Int32Array, start: number): Uint32Array {
    const { nbrOffsets: off, nbrs: nb } = this.g;
    const s = this.nextStamp();
    const stamp = this.stamp;
    const q = this.queue;
    q.length = 0;
    if (start < 0) return q.view();
    const lab = labels[start];
    stamp[start] = s;
    q.push(start);
    for (let k = 0; k < q.length; k++) {
      const c = q.data[k];
      for (let p = off[c], end = off[c + 1]; p < end; p++) {
        const d = nb[p];
        if (stamp[d] === s || labels[d] !== lab) continue;
        stamp[d] = s;
        q.push(d);
      }
    }
    return q.view();
  }
}

/**
 * cells を点 (qx,qy) を通る角度 angle の直線で 2 つに分け、片側(法線の正の側)のセルを返す。
 * どちらかの側が空なら null。
 */
export function splitSide(points: Float32Array, cells: Uint32Array, qx: number, qy: number, angle: number): Uint32Array | null {
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  let pos = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if ((points[2 * c] - qx) * nx + (points[2 * c + 1] - qy) * ny > 0) pos++;
  }
  if (pos === 0 || pos === cells.length) return null;
  const out = new Uint32Array(pos);
  let m = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if ((points[2 * c] - qx) * nx + (points[2 * c + 1] - qy) * ny > 0) out[m++] = c;
  }
  return out;
}

/** 1 回の操作(ストローク)の差分 */
export interface EditDiff {
  cells: Uint32Array;
  oldLabels: Int32Array;
  newLabels: Int32Array;
}

/**
 * ラベル配列の編集履歴。操作ごとに変わったセルとその前後のラベルだけを記録する。
 * begin() → set(...)* → commit() の順に使う。
 */
export class EditHistory {
  private undoStack: EditDiff[] = [];
  private redoStack: EditDiff[] = [];
  private touched: Int32Array;
  private strokeId = 0;
  private active = false;
  private sCells = new U32Buffer();
  private sOld = new I32Buffer();
  /** 保持する履歴の最大数 */
  limit = 500;

  constructor(
    private labels: Int32Array,
    numCells: number,
  ) {
    this.touched = new Int32Array(numCells);
  }

  get inStroke(): boolean {
    return this.active;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  begin(): void {
    if (this.active) this.commit();
    this.active = true;
    if (this.strokeId === 0x7fffffff) {
      this.touched.fill(0);
      this.strokeId = 0;
    }
    this.strokeId++;
    this.sCells.length = 0;
    this.sOld.length = 0;
  }

  /** セル c のラベルを lab にする。変わったら true */
  set(c: number, lab: number): boolean {
    const labels = this.labels;
    const old = labels[c];
    if (old === lab) return false;
    if (this.touched[c] !== this.strokeId) {
      this.touched[c] = this.strokeId;
      this.sCells.push(c);
      this.sOld.push(old);
    }
    labels[c] = lab;
    return true;
  }

  /** 複数セルを同じラベルにする。変わったセル数を返す */
  setMany(cells: Uint32Array, lab: number): number {
    let changed = 0;
    for (let k = 0; k < cells.length; k++) if (this.set(cells[k], lab)) changed++;
    return changed;
  }

  /** ストロークを確定する。実際に変化があった場合は履歴に積んで true */
  commit(): boolean {
    if (!this.active) return false;
    this.active = false;
    const n = this.sCells.length;
    const labels = this.labels;
    let m = 0;
    for (let k = 0; k < n; k++) if (labels[this.sCells.data[k]] !== this.sOld.data[k]) m++;
    if (m === 0) return false;
    const diff: EditDiff = { cells: new Uint32Array(m), oldLabels: new Int32Array(m), newLabels: new Int32Array(m) };
    let j = 0;
    for (let k = 0; k < n; k++) {
      const c = this.sCells.data[k];
      const o = this.sOld.data[k];
      if (labels[c] === o) continue;
      diff.cells[j] = c;
      diff.oldLabels[j] = o;
      diff.newLabels[j] = labels[c];
      j++;
    }
    this.undoStack.push(diff);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  /** 直前の操作を取り消す。変わったセルを返す(なければ null) */
  undo(): Uint32Array | null {
    if (this.active) this.commit();
    const d = this.undoStack.pop();
    if (!d) return null;
    for (let k = 0; k < d.cells.length; k++) this.labels[d.cells[k]] = d.oldLabels[k];
    this.redoStack.push(d);
    return d.cells;
  }

  redo(): Uint32Array | null {
    if (this.active) this.commit();
    const d = this.redoStack.pop();
    if (!d) return null;
    for (let k = 0; k < d.cells.length; k++) this.labels[d.cells[k]] = d.newLabels[k];
    this.undoStack.push(d);
    return d.cells;
  }
}

/** ラベルの最大値 */
export function maxLabel(labels: Int32Array): number {
  let m = -1;
  for (let i = 0; i < labels.length; i++) if (labels[i] > m) m = labels[i];
  return m;
}
