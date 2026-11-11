// 地図の表示: 視点変換(パン・ズーム)、画素ごとのセル番号バッファ、色塗りパス。
// ポリゴンは描かず、画素数に比例する手間だけで描画する(セル数に依存しない)。

import { computeCellBuffer, computeSafeRadii, nearestSite } from './nearest';
import type { SiteGraph } from './nearest';
import { BORDER_COLOR, PALETTES, UNKNOWN_COLOR, mixColor, normalizeCssColor, packColor } from './palette';

export interface MapData extends SiteGraph {
  aspect: number;
  /** セルごとの領域ラベル(編集で書き換わる。参照を共有する) */
  labels: Int32Array;
}

/** ID バッファの最大画素数 */
const MAX_BUFFER_PIXELS = 2_500_000;
/** 平均セルの大きさ(バッファ画素)がこれ未満なら境界線を描かない */
const MIN_CELL_PX_FOR_BORDERS = 3;
/** サイトの点を描くのはセルがこれ以上の大きさ(CSS px)のとき */
const MIN_CELL_PX_FOR_SITES = 10;
/** ズームの上限: 画面の横幅に並ぶセル数の目安 */
const MIN_CELLS_ACROSS = 30;

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // 画面とバッファの大きさ
  cssW = 1;
  cssH = 1;
  /** バッファ画素 / CSS px */
  bufScale = 1;
  W = 1;
  H = 1;

  // 視点: 画面(CSS px) = ワールド × scale + (tx, ty)
  scale = 1;
  tx = 0;
  ty = 0;

  map: MapData | null = null;
  colors: Uint8Array | null = null;
  /** セルごとの強調表示フラグ(選択中の領域) */
  highlight: Uint8Array | null = null;
  paletteIndex = 0;
  showSites = false;

  private cellAt = new Int32Array(1);
  private image: ImageData | null = null;
  private pix = new Uint32Array(1);
  private idsValid = false;
  private idsStep = 1;
  private colorsValid = false;
  private raf = 0;
  private interactive = false;
  private refineTimer = 0;
  private hint = 0;
  private lastFullIdsMs = 0;
  private siteStamp: Int32Array | null = null;
  /** 各サイトの内接円の半径の 2 乗(ID バッファ計算の近道) */
  private safeR2: Float32Array | null = null;
  private siteStampCur = 0;
  /** 直前に全解像度で計算した ID バッファの視点(パンのときはずらして再利用する) */
  private idsShiftable = false;
  private idsTx = 0;
  private idsTy = 0;
  private idsScale = 0;
  /** パン量をバッファ画素の整数倍に揃えたときの端数 */
  private panResX = 0;
  private panResY = 0;
  private stripBuf = new Int32Array(0);

  private bgColor = packColor('#f4f3ef');
  private lastBg = '';

  /** 視点が変わったときに呼ばれる(ブラシカーソルの更新など) */
  onViewChange: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D が使えません');
    this.ctx = ctx;
    this.readTheme();
    this.resize();
  }

  /** CSS 変数 --map-outside から地図外の背景色を読む */
  readTheme(): void {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--map-outside');
    const hex = normalizeCssColor(css, '#f4f3ef');
    if (hex !== this.lastBg) {
      this.lastBg = hex;
      this.bgColor = packColor(hex);
      this.invalidateColors();
    }
  }

  // -------------------------------------------------------------------------
  // 大きさ・視点

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const bufScale = Math.min(dpr, Math.sqrt(MAX_BUFFER_PIXELS / (cssW * cssH)));
    const W = Math.max(1, Math.round(cssW * bufScale));
    const H = Math.max(1, Math.round(cssH * bufScale));
    const hadMap = this.map !== null;
    // 画面中央のワールド座標を保つ
    const cx = (this.cssW / 2 - this.tx) / this.scale;
    const cy = (this.cssH / 2 - this.ty) / this.scale;
    this.cssW = cssW;
    this.cssH = cssH;
    this.bufScale = W / cssW;
    this.idsShiftable = false;
    if (W !== this.W || H !== this.H || this.image === null) {
      this.W = W;
      this.H = H;
      this.canvas.width = W;
      this.canvas.height = H;
      this.cellAt = new Int32Array(W * H);
      this.image = this.ctx.createImageData(W, H);
      this.pix = new Uint32Array(this.image.data.buffer);
    }
    if (hadMap) {
      this.tx = cssW / 2 - cx * this.scale;
      this.ty = cssH / 2 - cy * this.scale;
      this.clampView();
    }
    this.invalidateIds(false);
  }

  setMap(map: MapData): void {
    this.map = map;
    this.colors = null;
    this.highlight = null;
    this.hint = 0;
    this.siteStamp = null;
    this.safeR2 = computeSafeRadii(map);
    this.idsShiftable = false;
    this.fit();
  }

  setColors(colors: Uint8Array | null): void {
    this.colors = colors;
    this.invalidateColors();
  }

  private fitScale(): number {
    const aspect = this.map ? this.map.aspect : 1;
    return Math.min(this.cssW / aspect, this.cssH) * 0.98;
  }

  private maxScale(): number {
    if (!this.map) return this.fitScale();
    const cellSize = Math.sqrt(this.map.aspect / Math.max(1, this.map.numCells));
    return Math.max(this.fitScale() * 2, this.cssW / (MIN_CELLS_ACROSS * cellSize));
  }

  /** 地図全体が見えるようにする */
  fit(): void {
    const aspect = this.map ? this.map.aspect : 1;
    this.scale = this.fitScale();
    this.tx = (this.cssW - aspect * this.scale) / 2;
    this.ty = (this.cssH - this.scale) / 2;
    this.invalidateIds(false);
  }

  /** 画面上の点 (x,y) を中心に factor 倍ズームする */
  zoomAt(x: number, y: number, factor: number): void {
    const s = Math.min(this.maxScale(), Math.max(this.fitScale() * 0.5, this.scale * factor));
    const wx = (x - this.tx) / this.scale;
    const wy = (y - this.ty) / this.scale;
    this.scale = s;
    this.tx = x - wx * s;
    this.ty = y - wy * s;
    this.clampView();
    this.invalidateIds(true);
  }

  panBy(dx: number, dy: number): void {
    // バッファ画素の整数倍だけ動かす(ID バッファをずらして再利用できるように)。端数は次回に持ち越す
    const b = this.bufScale;
    this.panResX += dx * b;
    this.panResY += dy * b;
    const ix = Math.round(this.panResX);
    const iy = Math.round(this.panResY);
    this.panResX -= ix;
    this.panResY -= iy;
    this.tx += ix / b;
    this.ty += iy / b;
    this.clampView();
    this.invalidateIds(true);
  }

  /** 地図が画面から完全に出ていかないようにする */
  private clampView(): void {
    const aspect = this.map ? this.map.aspect : 1;
    const margin = Math.min(80, this.cssW / 4, this.cssH / 4);
    const mapW = aspect * this.scale;
    const mapH = this.scale;
    this.tx = Math.min(this.cssW - margin, Math.max(margin - mapW, this.tx));
    this.ty = Math.min(this.cssH - margin, Math.max(margin - mapH, this.ty));
  }

  screenToWorldX(x: number): number {
    return (x - this.tx) / this.scale;
  }
  screenToWorldY(y: number): number {
    return (y - this.ty) / this.scale;
  }

  /** 画面上の点 (CSS px) の下にあるセル。地図の外なら -1 */
  cellAtScreen(x: number, y: number): number {
    const m = this.map;
    if (!m || m.numCells === 0) return -1;
    const wx = this.screenToWorldX(x);
    const wy = this.screenToWorldY(y);
    if (wx < 0 || wx > m.aspect || wy < 0 || wy > 1) return -1;
    let start = this.hint;
    const bi = Math.floor(x * this.bufScale);
    const bj = Math.floor(y * this.bufScale);
    if (bi >= 0 && bi < this.W && bj >= 0 && bj < this.H) {
      const c = this.cellAt[bj * this.W + bi];
      if (c >= 0) start = c;
    }
    return nearestSite(m, start, wx, wy);
  }

  /** 平均的なセルの一辺の長さ (CSS px) */
  cellSizePx(): number {
    if (!this.map) return 1;
    return Math.sqrt(this.map.aspect / Math.max(1, this.map.numCells)) * this.scale;
  }

  // -------------------------------------------------------------------------
  // 描画のスケジュール

  /** セル番号バッファを作り直す。interactive なら操作中なので粗い解像度でもよい */
  invalidateIds(interactive: boolean): void {
    this.idsValid = false;
    this.colorsValid = false;
    if (interactive) {
      this.interactive = true;
      window.clearTimeout(this.refineTimer);
      this.refineTimer = window.setTimeout(() => {
        this.interactive = false;
        if (this.idsStep !== 1) this.invalidateIds(false);
      }, 160);
    } else {
      this.interactive = false;
    }
    this.schedule();
    this.onViewChange?.();
  }

  /** 色(とラベル境界)だけを塗り直す */
  invalidateColors(): void {
    this.colorsValid = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    if (!this.image) return;
    const m = this.map;
    if (!m) {
      this.pix.fill(this.bgColor);
      this.ctx.putImageData(this.image, 0, 0);
      return;
    }
    if (!this.idsValid && this.tryShiftIds()) {
      this.idsValid = true;
    }
    if (!this.idsValid) {
      const t0 = performance.now();
      let step = 1;
      // 操作中で、全解像度の計算が重いときだけ粗くする
      if (this.interactive && this.lastFullIdsMs > 18) {
        step = this.W * this.H > 1_200_000 ? 3 : 2;
      }
      const px = 1 / (this.scale * this.bufScale);
      this.hint = computeCellBuffer(
        m,
        this.cellAt,
        {
          width: this.W,
          height: this.H,
          originX: -this.tx / this.scale,
          originY: -this.ty / this.scale,
          pixelSize: px,
          aspect: m.aspect,
          step,
        },
        this.hint,
        this.safeR2,
      );
      if (this.hint < 0) this.hint = 0;
      this.idsStep = step;
      this.idsValid = true;
      if (step === 1) this.lastFullIdsMs = performance.now() - t0;
      this.idsShiftable = step === 1;
      this.idsTx = this.tx;
      this.idsTy = this.ty;
      this.idsScale = this.scale;
    }
    if (!this.colorsValid) {
      this.colorPass();
      this.colorsValid = true;
      this.ctx.putImageData(this.image, 0, 0);
      if (this.showSites && this.cellSizePx() >= MIN_CELL_PX_FOR_SITES) this.drawSites();
    }
  }

  /**
   * 拡大率が同じで平行移動がバッファ画素の整数倍なら、前回の ID バッファをずらし、
   * 新しく見えた帯の部分だけを計算する。できなければ false。
   */
  private tryShiftIds(): boolean {
    const m = this.map;
    if (!m || !this.idsShiftable || this.scale !== this.idsScale) return false;
    const fx = (this.tx - this.idsTx) * this.bufScale;
    const fy = (this.ty - this.idsTy) * this.bufScale;
    const sx = Math.round(fx);
    const sy = Math.round(fy);
    if (Math.abs(fx - sx) > 1e-3 || Math.abs(fy - sy) > 1e-3) return false;
    const W = this.W;
    const H = this.H;
    if (Math.abs(sx) * 3 >= W || Math.abs(sy) * 3 >= H) return false;
    const out = this.cellAt;
    // 新しい画素 (i,j) = 古い画素 (i-sx, j-sy)。行の上書き順に注意してずらす
    const dst0 = Math.max(0, sx);
    const src0 = Math.max(0, -sx);
    const len = W - Math.abs(sx);
    if (sy >= 0) {
      for (let j = H - 1; j >= sy; j--) out.copyWithin(j * W + dst0, (j - sy) * W + src0, (j - sy) * W + src0 + len);
    } else {
      for (let j = 0; j < H + sy; j++) out.copyWithin(j * W + dst0, (j - sy) * W + src0, (j - sy) * W + src0 + len);
    }
    const px = 1 / (this.scale * this.bufScale);
    const ox = -this.tx / this.scale;
    const oy = -this.ty / this.scale;
    const spec = { width: W, height: 0, originX: ox, originY: oy, pixelSize: px, aspect: m.aspect, step: 1 };
    // 上下の帯(全幅)
    const r0 = sy > 0 ? 0 : H + sy;
    const r1 = sy > 0 ? sy : H;
    if (r1 > r0) {
      spec.height = r1 - r0;
      spec.originY = oy + r0 * px;
      this.hint = computeCellBuffer(m, out.subarray(r0 * W, r1 * W), spec, this.hint, this.safeR2);
      if (this.hint < 0) this.hint = 0;
    }
    // 左右の帯(上下の帯を除いた行)
    const cw = Math.abs(sx);
    const rr0 = sy > 0 ? sy : 0;
    const rr1 = sy > 0 ? H : H + sy;
    if (cw > 0 && rr1 > rr0) {
      const c0 = sx > 0 ? 0 : W + sx;
      const rows = rr1 - rr0;
      if (this.stripBuf.length < cw * rows) this.stripBuf = new Int32Array(cw * rows);
      const tmp = this.stripBuf.subarray(0, cw * rows);
      spec.width = cw;
      spec.height = rows;
      spec.originX = ox + c0 * px;
      spec.originY = oy + rr0 * px;
      this.hint = computeCellBuffer(m, tmp, spec, this.hint, this.safeR2);
      if (this.hint < 0) this.hint = 0;
      for (let j = 0; j < rows; j++) out.set(tmp.subarray(j * cw, (j + 1) * cw), (rr0 + j) * W + c0);
    }
    this.idsTx = this.tx;
    this.idsTy = this.ty;
    return true;
  }

  /** 画素 → セル → 色。境界線は右または下の画素と領域ラベルが違うときに描く */
  private colorPass(): void {
    const m = this.map!;
    const W = this.W;
    const H = this.H;
    const cellAt = this.cellAt;
    const pix = this.pix;
    const labels = m.labels;
    const colors = this.colors !== null && this.colors.length === m.numCells ? this.colors : null;
    const pal = PALETTES[this.paletteIndex] ?? PALETTES[0];
    // 0..3: 4 色, 4: 未着色。強調表示用は黒を少し混ぜたもの
    const base = new Uint32Array(5);
    const dark = new Uint32Array(5);
    for (let k = 0; k < 5; k++) {
      const hex = k < 4 ? pal.colors[k] : UNKNOWN_COLOR;
      base[k] = packColor(hex);
      dark[k] = packColor(mixColor(hex, '#000000', 0.35));
    }
    const bg = this.bgColor;
    const border = packColor(BORDER_COLOR);
    const borders = this.cellSizePx() * this.bufScale >= MIN_CELL_PX_FOR_BORDERS;
    const hl = this.highlight !== null && this.highlight.length === m.numCells ? this.highlight : null;

    for (let j = 0; j < H; j++) {
      const row = j * W;
      const lastRow = j === H - 1;
      for (let i = 0; i < W; i++) {
        const p = row + i;
        const c = cellAt[p];
        if (c < 0) {
          pix[p] = bg;
          continue;
        }
        let k = colors !== null ? colors[c] : 4;
        if (k > 4) k = 4;
        if (borders) {
          const lab = labels[c];
          const r = i + 1 < W ? cellAt[p + 1] : c;
          const d = lastRow ? c : cellAt[p + W];
          if ((r !== c && (r < 0 || labels[r] !== lab)) || (d !== c && (d < 0 || labels[d] !== lab))) {
            pix[p] = border;
            continue;
          }
        }
        if (hl !== null && hl[c] !== 0 && ((i + j) & 6) === 0) pix[p] = dark[k];
        else pix[p] = base[k];
      }
    }
  }

  /** 見えているセルのサイトを点で描く */
  private drawSites(): void {
    const m = this.map!;
    if (this.siteStamp === null || this.siteStamp.length !== m.numCells) {
      this.siteStamp = new Int32Array(m.numCells);
      this.siteStampCur = 0;
    }
    const stamp = this.siteStamp;
    const s = ++this.siteStampCur;
    const ctx = this.ctx;
    const k = this.scale * this.bufScale;
    const ox = this.tx * this.bufScale;
    const oy = this.ty * this.bufScale;
    const r = Math.max(1.2, 1.6 * this.bufScale);
    const cellAt = this.cellAt;
    const pts = m.points;
    ctx.fillStyle = 'rgba(30,30,30,0.75)';
    ctx.beginPath();
    for (let p = 0, n = cellAt.length; p < n; p++) {
      const c = cellAt[p];
      if (c < 0 || stamp[c] === s) continue;
      stamp[c] = s;
      const x = pts[2 * c] * k + ox;
      const y = pts[2 * c + 1] * k + oy;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
