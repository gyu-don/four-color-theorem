// エントリポイント: ワーカー・表示・ツール・パネルをつなぐ。
import workerSource from 'virtual:worker-source';
import type { FromWorker, ToWorker } from './protocol';
import { Panel } from './ui/panel';
import { TOOL_KEYS, ToolController } from './ui/tools';
import type { ToolName } from './ui/tools';
import { MapView } from './ui/view';
import type { MapData } from './ui/view';

const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));

function send(msg: ToWorker, transfer: Transferable[] = []): void {
  worker.postMessage(msg, transfer);
}

const canvas = document.getElementById('map') as HTMLCanvasElement;
const brushCursor = document.getElementById('brush-cursor') as HTMLElement;
const view = new MapView(canvas);

// ---------------------------------------------------------------------------
// 状態

let map: MapData | null = null;
let workerReady = false;
/** generate を送ってから map が届くまで true(この間は編集・彩色要求をしない) */
let awaitingMap = false;
let reqCounter = 0;
/** 返事待ちの recolor の reqId(なければ null) */
let outstanding: number | null = null;
/** 返事待ちの間に編集があった → 返事が来たらもう一度送る */
let dirty = false;
/** 最後に表示に反映した colors の reqId */
let appliedReqId = -1;

// ---------------------------------------------------------------------------
// 彩色要求(返事待ちは常に高々 1 件。間の編集はまとめて次の 1 件にする)

function requestRecolor(): void {
  if (!map || awaitingMap || !workerReady) return;
  if (outstanding !== null) {
    dirty = true;
    return;
  }
  dirty = false;
  const reqId = ++reqCounter;
  outstanding = reqId;
  const labels = map.labels.slice();
  send(
    { type: 'recolor', reqId, labels, kempeMode: panel.kempeMode, identifyDegree4: panel.identifyDegree4 },
    [labels.buffer],
  );
  panel.setBusy(true);
}

function replyArrived(reqId: number | undefined): void {
  if (reqId !== undefined && outstanding !== null && reqId >= outstanding) outstanding = null;
  if (outstanding === null) {
    panel.setBusy(false);
    if (dirty) requestRecolor();
  }
}

// ---------------------------------------------------------------------------
// パネル・ツール

const panel = new Panel({
  onGenerate: generate,
  onTool: (t) => setTool(t),
  onBrushRadius: (px) => tools.setBrushRadius(px),
  onUndo: () => tools.undo(),
  onRedo: () => tools.redo(),
  onFit: () => view.fit(),
  onKempeMode: () => requestRecolor(),
  onRecolor: () => requestRecolor(),
  onPalette: (i) => {
    view.paletteIndex = i;
    view.invalidateColors();
  },
  onShowSites: (show) => {
    view.showSites = show;
    view.invalidateColors();
  },
});

const tools = new ToolController(view, {
  onEdit: (final) => {
    // 境界はすぐに手元のラベルから描き直し、色はワーカーの返事を待つ
    view.invalidateColors();
    requestRecolor();
    if (final) panel.setHistory(tools.canUndo, tools.canRedo);
  },
  onHistoryChange: () => panel.setHistory(tools.canUndo, tools.canRedo),
  onStatus: (msg) => panel.setStatus(msg, false, msg.startsWith('結合') ? 0 : 2500),
  canEdit: () => map !== null && !awaitingMap,
}, brushCursor);
tools.setBrushRadius(panel.brushRadius);

function setTool(t: ToolName): void {
  tools.setTool(t);
  panel.setTool(t);
}
setTool('expand');

function generate(): void {
  if (!workerReady || awaitingMap) return;
  const aspect = window.innerWidth / Math.max(1, window.innerHeight);
  const params = panel.readGenerateParams(Math.min(4, Math.max(0.25, aspect)));
  awaitingMap = true;
  dirty = false;
  outstanding = null;
  panel.setBusy(false);
  panel.setGenerating('地図を生成中…');
  send({ type: 'generate', params, kempeMode: panel.kempeMode, identifyDegree4: panel.identifyDegree4 });
}

// ---------------------------------------------------------------------------
// ワーカーからのメッセージ

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'ready':
      workerReady = true;
      generate();
      break;
    case 'progress':
      if (awaitingMap) panel.setGenerating(msg.phase);
      else panel.setBusy(true);
      break;
    case 'map': {
      awaitingMap = false;
      panel.setGenerating(null);
      map = {
        numCells: msg.params.numCells,
        aspect: msg.params.aspect,
        points: msg.points,
        nbrOffsets: msg.nbrOffsets,
        nbrs: msg.nbrs,
        labels: msg.labels,
      };
      view.setMap(map);
      tools.setMap(map);
      panel.setMapInfo(map.numCells, msg.msGenerate);
      // ワーカーは map の直後に reqId 0 で彩色して返す
      appliedReqId = -1;
      outstanding = 0;
      dirty = false;
      panel.setBusy(true);
      break;
    }
    case 'colors': {
      if (awaitingMap || !map) break;
      if (msg.reqId > appliedReqId && msg.colors.length === map.numCells) {
        appliedReqId = msg.reqId;
        view.setColors(msg.colors);
        panel.setStats(msg.stats);
      }
      replyArrived(msg.reqId);
      break;
    }
    case 'error':
      console.error('ワーカーのエラー:', msg.message);
      panel.setStatus(`エラー: ${msg.message}`, true, 8000);
      if (msg.reqId === undefined && awaitingMap) {
        awaitingMap = false;
        panel.setGenerating(null);
      }
      replyArrived(msg.reqId);
      break;
  }
};

worker.onerror = (e) => {
  console.error(e);
  panel.setStatus(`ワーカーでエラーが発生しました: ${e.message}`, true);
  awaitingMap = false;
  panel.setGenerating(null);
};

panel.setGenerating('準備中…');

// ---------------------------------------------------------------------------
// キーボード

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement) return t.type !== 'checkbox' && t.type !== 'range';
  return t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
}

const keyToTool = new Map<string, ToolName>(
  (Object.entries(TOOL_KEYS) as [ToolName, string][]).map(([t, k]) => [k.toLowerCase(), t]),
);

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) tools.redo();
    else tools.undo();
    return;
  }
  if (mod && key === 'y') {
    e.preventDefault();
    tools.redo();
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) tools.setSpace(true);
    return;
  }
  if (e.key === 'Escape') {
    tools.clearSelection();
    return;
  }
  if (e.key === '[') return panel.nudgeBrushRadius(-2);
  if (e.key === ']') return panel.nudgeBrushRadius(2);
  if (key === 'f') return view.fit();
  if (key === 'r') return requestRecolor();
  const t = keyToTool.get(key);
  if (t) setTool(t);
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') tools.setSpace(false);
});
window.addEventListener('blur', () => tools.setSpace(false));

// ---------------------------------------------------------------------------
// 画面の大きさ・テーマ

let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    view.resize();
  });
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => view.readTheme());
