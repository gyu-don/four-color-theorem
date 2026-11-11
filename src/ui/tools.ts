// 編集ツールとポインタ操作(パン・ズーム・ブラシ・結合・分割)、元に戻す/やり直す。

import { CellWalker, EditHistory, maxLabel, splitSide } from './edit';
import { nearestSite } from './nearest';
import type { MapData, MapView } from './view';

export type ToolName = 'pan' | 'expand' | 'paint' | 'merge' | 'split';

export const TOOL_KEYS: Record<ToolName, string> = {
  pan: 'H',
  expand: 'B',
  paint: 'N',
  merge: 'M',
  split: 'S',
};

export interface ToolHost {
  /** ラベルが変わった。final はストロークの終わり(または単発の操作) */
  onEdit(final: boolean): void;
  /** 元に戻す/やり直すの可否が変わった */
  onHistoryChange(): void;
  /** 状態表示(空文字で消す) */
  onStatus(msg: string): void;
  /** いま編集してよいか(地図の生成中などは false) */
  canEdit(): boolean;
}

type Drag =
  | { kind: 'pan'; id: number; lastX: number; lastY: number }
  | { kind: 'brush'; id: number; label: number; lastWX: number; lastWY: number; lastCell: number }
  | { kind: 'click'; id: number; startX: number; startY: number; moved: boolean };

/** クリックとみなす移動量の上限 (CSS px) */
const CLICK_SLOP = 5;

export class ToolController {
  tool: ToolName = 'expand';
  /** ブラシ半径 (CSS px) */
  brushRadius = 18;

  private map: MapData | null = null;
  private walker: CellWalker | null = null;
  private history: EditHistory | null = null;
  private nextLabel = 0;

  private drag: Drag | null = null;
  private spaceHeld = false;
  /** タッチのピンチ操作用 */
  private touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  // 結合ツールの選択状態
  private selLabel = -1;
  private selCells: Uint32Array | null = null;
  private selMask: Uint8Array | null = null;

  private cursorX = -1;
  private cursorY = -1;

  constructor(
    private view: MapView,
    private host: ToolHost,
    private brushCursor: HTMLElement,
  ) {
    const c = view.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.cursorX = -1;
      this.updateCursor();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    view.onViewChange = () => this.updateCursor();
    this.updateCursor();
  }

  setMap(map: MapData): void {
    this.map = map;
    this.walker = new CellWalker(map);
    this.history = new EditHistory(map.labels, map.numCells);
    this.nextLabel = maxLabel(map.labels) + 1;
    this.drag = null;
    this.selMask = new Uint8Array(map.numCells);
    this.selCells = null;
    this.selLabel = -1;
    this.view.highlight = null;
    this.host.onHistoryChange();
  }

  setTool(t: ToolName): void {
    if (this.tool === t) return;
    this.finishStroke();
    this.clearSelection();
    this.tool = t;
    this.host.onStatus(t === 'merge' ? '結合: 1 つ目の領域をクリック' : '');
    this.updateCursor();
  }

  setSpace(held: boolean): void {
    this.spaceHeld = held;
    this.updateCursor();
  }

  setBrushRadius(px: number): void {
    this.brushRadius = px;
    this.updateCursor();
  }

  get canUndo(): boolean {
    return this.history?.canUndo ?? false;
  }
  get canRedo(): boolean {
    return this.history?.canRedo ?? false;
  }

  undo(): void {
    if (!this.history || !this.host.canEdit()) return;
    this.finishStroke();
    this.clearSelection();
    if (this.history.undo()) {
      this.host.onEdit(true);
      this.host.onHistoryChange();
    }
  }

  redo(): void {
    if (!this.history || !this.host.canEdit()) return;
    this.finishStroke();
    this.clearSelection();
    if (this.history.redo()) {
      this.host.onEdit(true);
      this.host.onHistoryChange();
    }
  }

  clearSelection(): void {
    if (this.selCells && this.selMask) {
      for (let k = 0; k < this.selCells.length; k++) this.selMask[this.selCells[k]] = 0;
    }
    this.selCells = null;
    this.selLabel = -1;
    if (this.view.highlight !== null) {
      this.view.highlight = null;
      this.view.invalidateColors();
    }
    if (this.tool === 'merge') this.host.onStatus('結合: 1 つ目の領域をクリック');
  }

  // -------------------------------------------------------------------------
  // ポインタ

  private localXY(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.view.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onDown(e: PointerEvent): void {
    const [x, y] = this.localXY(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x, y });
      if (this.touches.size === 2) {
        // 2 本指: 進行中のストロークを確定してピンチに切り替える
        this.finishStroke();
        this.drag = null;
        this.pinchDist = this.touchSpread();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.drag) return;
    this.view.canvas.setPointerCapture(e.pointerId);
    const panButton = e.button === 1 || e.button === 2;
    if (panButton || this.spaceHeld || this.tool === 'pan') {
      e.preventDefault();
      this.drag = { kind: 'pan', id: e.pointerId, lastX: x, lastY: y };
      this.updateCursor();
      return;
    }
    if (e.button !== 0 || !this.map || !this.history || !this.walker || !this.host.canEdit()) return;
    if (this.tool === 'expand' || this.tool === 'paint') {
      const cell = this.view.cellAtScreen(x, y);
      if (cell < 0) return;
      const label = this.tool === 'expand' ? this.map.labels[cell] : this.nextLabel++;
      const wx = this.view.screenToWorldX(x);
      const wy = this.view.screenToWorldY(y);
      this.history.begin();
      this.drag = { kind: 'brush', id: e.pointerId, label, lastWX: wx, lastWY: wy, lastCell: cell };
      this.dab(cell, wx, wy, label);
      this.host.onEdit(false);
    } else {
      this.drag = { kind: 'click', id: e.pointerId, startX: x, startY: y, moved: false };
    }
  }

  private onMove(e: PointerEvent): void {
    const [x, y] = this.localXY(e);
    this.cursorX = x;
    this.cursorY = y;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId)!;
      if (this.touches.size === 2) {
        // ピンチ: 2 本指の中点の移動でパン、間隔の変化でズーム
        const n = this.touches.size;
        this.view.panBy((x - prev.x) / n, (y - prev.y) / n);
        prev.x = x;
        prev.y = y;
        const d = this.touchSpread();
        if (this.pinchDist > 0 && d > 0) {
          const [mx, my] = this.touchMid();
          this.view.zoomAt(mx, my, d / this.pinchDist);
        }
        this.pinchDist = d;
        return;
      }
      prev.x = x;
      prev.y = y;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) {
      this.updateCursor();
      return;
    }
    if (d.kind === 'pan') {
      this.view.panBy(x - d.lastX, y - d.lastY);
      d.lastX = x;
      d.lastY = y;
    } else if (d.kind === 'brush') {
      this.strokeTo(d, this.view.screenToWorldX(x), this.view.screenToWorldY(y));
      this.host.onEdit(false);
    } else if (Math.hypot(x - d.startX, y - d.startY) > CLICK_SLOP) {
      d.moved = true;
    }
    this.updateCursor();
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      this.pinchDist = this.touches.size === 2 ? this.touchSpread() : 0;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (this.view.canvas.hasPointerCapture(e.pointerId)) this.view.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    if (d.kind === 'brush') {
      this.finishBrush();
    } else if (d.kind === 'click' && !d.moved && e.type === 'pointerup') {
      const [x, y] = this.localXY(e);
      if (this.tool === 'merge') this.mergeClick(x, y);
      else if (this.tool === 'split') this.splitClick(x, y);
    }
    this.updateCursor();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.localXY(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    // トラックパッドのピンチは ctrlKey 付きの wheel として届く(変化量が小さいので係数を大きく)
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * k);
    this.view.zoomAt(x, y, factor);
  }

  private touchSpread(): number {
    const ps = [...this.touches.values()];
    return ps.length < 2 ? 0 : Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  private touchMid(): [number, number] {
    const ps = [...this.touches.values()];
    return [(ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2];
  }

  // -------------------------------------------------------------------------
  // ブラシ

  /** 1 か所にブラシを当てる */
  private dab(start: number, wx: number, wy: number, label: number): void {
    const cells = this.walker!.brush(start, wx, wy, this.brushRadius / this.view.scale);
    this.history!.setMany(cells, label);
  }

  /** 前回の位置から (wx,wy) まで、半径の半分の間隔でブラシを当てる */
  private strokeTo(d: Extract<Drag, { kind: 'brush' }>, wx: number, wy: number): void {
    const m = this.map!;
    const r = this.brushRadius / this.view.scale;
    const dist = Math.hypot(wx - d.lastWX, wy - d.lastWY);
    const n = Math.max(1, Math.ceil(dist / Math.max(r * 0.5, 1e-9)));
    let cell = d.lastCell;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const px = d.lastWX + (wx - d.lastWX) * t;
      const py = d.lastWY + (wy - d.lastWY) * t;
      cell = nearestSite(m, cell, px, py);
      this.dab(cell, px, py, d.label);
    }
    d.lastWX = wx;
    d.lastWY = wy;
    d.lastCell = cell;
  }

  private finishBrush(): void {
    if (!this.history) return;
    const changed = this.history.commit();
    this.host.onEdit(true);
    if (changed) this.host.onHistoryChange();
  }

  /** ツール切り替えなどで進行中のストロークを確定する */
  private finishStroke(): void {
    if (this.drag?.kind === 'brush') {
      this.drag = null;
      this.finishBrush();
    }
  }

  // -------------------------------------------------------------------------
  // 結合・分割

  private mergeClick(x: number, y: number): void {
    const m = this.map;
    const walker = this.walker;
    const mask = this.selMask;
    if (!m || !walker || !mask || !this.history) return;
    const cell = this.view.cellAtScreen(x, y);
    if (cell < 0) {
      this.clearSelection();
      return;
    }
    if (this.selCells === null) {
      // 1 つ目: 選択して強調表示
      const comp = walker.component(m.labels, cell).slice();
      for (let k = 0; k < comp.length; k++) mask[comp[k]] = 1;
      this.selCells = comp;
      this.selLabel = m.labels[cell];
      this.view.highlight = mask;
      this.view.invalidateColors();
      this.host.onStatus('結合: 結合する領域をクリック (Esc で解除)');
      return;
    }
    if (mask[cell] !== 0) {
      this.clearSelection();
      return;
    }
    // 2 つ目: その連結成分を 1 つ目のラベルに付け替える
    const comp = walker.component(m.labels, cell).slice();
    this.history.begin();
    this.history.setMany(comp, this.selLabel);
    const changed = this.history.commit();
    // 選択を広げておき、続けてクリックすれば次々に結合できるようにする
    for (let k = 0; k < comp.length; k++) mask[comp[k]] = 1;
    const merged = new Uint32Array(this.selCells.length + comp.length);
    merged.set(this.selCells);
    merged.set(comp, this.selCells.length);
    this.selCells = merged;
    this.view.invalidateColors();
    if (changed) {
      this.host.onEdit(true);
      this.host.onHistoryChange();
    }
  }

  private splitClick(x: number, y: number): void {
    const m = this.map;
    const walker = this.walker;
    if (!m || !walker || !this.history) return;
    const cell = this.view.cellAtScreen(x, y);
    if (cell < 0) return;
    const comp = walker.component(m.labels, cell);
    const side = splitSide(m.points, comp, this.view.screenToWorldX(x), this.view.screenToWorldY(y), Math.random() * Math.PI);
    if (side === null) {
      this.host.onStatus('この領域はこれ以上分割できません');
      return;
    }
    this.host.onStatus('');
    this.history.begin();
    this.history.setMany(side, this.nextLabel++);
    if (this.history.commit()) {
      this.host.onEdit(true);
      this.host.onHistoryChange();
    }
  }

  // -------------------------------------------------------------------------
  // カーソル

  private updateCursor(): void {
    const c = this.view.canvas;
    const panning = this.drag?.kind === 'pan';
    const panMode = this.spaceHeld || this.tool === 'pan';
    const brushTool = this.tool === 'expand' || this.tool === 'paint';
    if (panning) c.style.cursor = 'grabbing';
    else if (panMode) c.style.cursor = 'grab';
    else if (brushTool) c.style.cursor = 'crosshair';
    else c.style.cursor = 'pointer';
    const show = brushTool && !panMode && !panning && this.cursorX >= 0;
    const el = this.brushCursor;
    if (!show) {
      el.style.display = 'none';
      return;
    }
    const r = this.brushRadius;
    el.style.display = 'block';
    el.style.width = el.style.height = `${2 * r}px`;
    el.style.transform = `translate(${this.cursorX - r}px, ${this.cursorY - r}px)`;
  }
}
