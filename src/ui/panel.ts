// 操作パネルと統計パネル(DOM とのやり取りだけを受け持つ)。

import type { ColorStats, Distribution, GenerateParams } from '../protocol';
import { PALETTES } from './palette';
import type { ToolName } from './tools';

export interface PanelHandlers {
  onGenerate(): void;
  onTool(t: ToolName): void;
  onBrushRadius(px: number): void;
  onUndo(): void;
  onRedo(): void;
  onFit(): void;
  /** 彩色の設定(Kempe モード・次数 4 の扱い)が変わった */
  onKempeMode(): void;
  onRecolor(): void;
  onPalette(index: number): void;
  onShowSites(show: boolean): void;
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素 #${id} がありません`);
  return el as T;
}

const nf = new Intl.NumberFormat('ja-JP');

function fmtInt(x: number): string {
  return nf.format(Math.round(x));
}

function fmtMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 10000) return `${fmtInt(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export const MAX_UI_CELLS = 2_000_000;
export const MIN_UI_CELLS = 100;

export class Panel {
  private numCells = $<HTMLInputElement>('num-cells');
  private distribution = $<HTMLSelectElement>('distribution');
  private cellsPerRegion = $<HTMLSelectElement>('cells-per-region');
  private seed = $<HTMLInputElement>('seed');
  private generateBtn = $<HTMLButtonElement>('generate');
  private undoBtn = $<HTMLButtonElement>('undo');
  private redoBtn = $<HTMLButtonElement>('redo');
  private recolorBtn = $<HTMLButtonElement>('recolor');
  private kempe = $<HTMLSelectElement>('kempe-mode');
  private deg4 = $<HTMLSelectElement>('deg4-mode');
  private radius = $<HTMLInputElement>('brush-radius');
  private radiusOut = $<HTMLOutputElement>('brush-radius-out');
  private toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools button[data-tool]')];
  private busy = $<HTMLElement>('busy');
  private status = $<HTMLElement>('status');
  private progress = $<HTMLElement>('progress');
  private progressText = $<HTMLElement>('progress-text');
  private statusTimer = 0;

  constructor(private h: PanelHandlers) {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#presets button[data-n]')) {
      b.addEventListener('click', () => {
        this.numCells.value = b.dataset.n ?? '200000';
      });
    }
    $('seed-random').addEventListener('click', () => {
      this.seed.value = String(Math.floor(Math.random() * 1_000_000));
    });
    this.generateBtn.addEventListener('click', () => h.onGenerate());
    for (const b of this.toolButtons) {
      b.addEventListener('click', () => h.onTool(b.dataset.tool as ToolName));
    }
    this.radius.addEventListener('input', () => {
      this.radiusOut.value = this.radius.value;
      h.onBrushRadius(Number(this.radius.value));
    });
    this.undoBtn.addEventListener('click', () => h.onUndo());
    this.redoBtn.addEventListener('click', () => h.onRedo());
    $('fit').addEventListener('click', () => h.onFit());
    this.kempe.addEventListener('change', () => h.onKempeMode());
    this.deg4.addEventListener('change', () => h.onKempeMode());
    this.recolorBtn.addEventListener('click', () => h.onRecolor());

    const pal = $<HTMLSelectElement>('palette');
    PALETTES.forEach((p, i) => pal.add(new Option(p.name, String(i))));
    pal.addEventListener('change', () => h.onPalette(Number(pal.value)));
    const sites = $<HTMLInputElement>('show-sites');
    sites.addEventListener('change', () => h.onShowSites(sites.checked));

    this.setupCollapse('panel', 'panel-toggle', 'パネル');
    this.setupCollapse('stats', 'stats-toggle', '統計');
  }

  private setupCollapse(panelId: string, btnId: string, name: string): void {
    const panel = $(panelId);
    const btn = $<HTMLButtonElement>(btnId);
    btn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      btn.textContent = collapsed ? '+' : '−';
      btn.title = collapsed ? `${name}を開く` : `${name}を畳む`;
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  /** 入力欄から生成パラメータを読む(範囲外の値は丸めて入力欄にも反映する) */
  readGenerateParams(aspect: number): GenerateParams {
    let n = Math.round(Number(this.numCells.value));
    if (!Number.isFinite(n)) n = 200_000;
    n = Math.min(MAX_UI_CELLS, Math.max(MIN_UI_CELLS, n));
    this.numCells.value = String(n);
    let seed = Math.floor(Number(this.seed.value));
    if (!Number.isFinite(seed) || seed < 0) seed = 1;
    seed = seed >>> 0;
    this.seed.value = String(seed);
    return {
      numCells: n,
      distribution: this.distribution.value as Distribution,
      cellsPerRegion: Number(this.cellsPerRegion.value) || 1,
      seed,
      aspect,
    };
  }

  get kempeMode(): 'greedy' | 'random' {
    return this.kempe.value === 'random' ? 'random' : 'greedy';
  }

  /** 次数 4 の頂点を同一視で処理するか */
  get identifyDegree4(): boolean {
    return this.deg4.value !== 'kempe';
  }

  get brushRadius(): number {
    return Number(this.radius.value);
  }

  /** ブラシ半径を delta だけ変える(キーボード用) */
  nudgeBrushRadius(delta: number): void {
    const v = Math.min(Number(this.radius.max), Math.max(Number(this.radius.min), this.brushRadius + delta));
    this.radius.value = String(v);
    this.radiusOut.value = String(v);
    this.h.onBrushRadius(v);
  }

  setTool(t: ToolName): void {
    for (const b of this.toolButtons) {
      const on = b.dataset.tool === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }

  /** 彩色要求が出ている間の表示 */
  setBusy(busy: boolean): void {
    this.busy.hidden = !busy;
  }

  /** 地図の生成中の表示。phase が null なら消す */
  setGenerating(phase: string | null): void {
    this.progress.hidden = phase === null;
    if (phase !== null) this.progressText.textContent = phase;
    this.generateBtn.disabled = phase !== null;
    this.recolorBtn.disabled = phase !== null;
  }

  /** 画面下に短い状態表示を出す(空文字で消す) */
  setStatus(msg: string, isError = false, timeoutMs = 0): void {
    window.clearTimeout(this.statusTimer);
    this.status.hidden = msg === '';
    this.status.textContent = msg;
    this.status.classList.toggle('error', isError);
    if (msg !== '' && timeoutMs > 0) {
      this.statusTimer = window.setTimeout(() => this.setStatus(''), timeoutMs);
    }
  }

  setMapInfo(numCells: number, msGenerate: number): void {
    $('st-cells').textContent = fmtInt(numCells);
    $('st-gen').textContent = fmtMs(msGenerate);
    for (const id of ['st-regions', 'st-solve', 'st-total', 'st-levels', 'st-configs', 'st-distinct', 'st-obstr', 'st-kempe', 'st-flipped', 'st-fallback']) {
      $(id).textContent = '–';
    }
    $('st-fallback').classList.remove('warn');
  }

  setStats(st: ColorStats): void {
    const s = st.solve;
    // numRegions は外側の「海」頂点を含むので 1 引いて表示する
    $('st-regions').textContent = fmtInt(Math.max(0, st.numRegions - 1));
    $('st-solve').textContent = fmtMs(s.msTotal);
    $('st-total').textContent = fmtMs(st.msTotal);
    $('st-levels').textContent = fmtInt(s.levels);
    $('st-configs').textContent = `${fmtInt(s.configsDeg3)} / ${fmtInt(s.configsDeg4)} / ${fmtInt(s.configsD)}`;
    $('st-configs').title = '次数3 / 次数4 / 集合𝒟';
    $('st-distinct').textContent = fmtInt(s.distinctD);
    $('st-obstr').textContent = fmtInt(s.identified);
    $('st-kempe').textContent = fmtInt(s.kempePasses);
    $('st-flipped').textContent = fmtInt(s.kempeFlipped);
    const fb = $('st-fallback');
    fb.textContent = fmtInt(s.fallbackVertices);
    fb.classList.toggle('warn', s.fallbackVertices > 0);
  }
}
