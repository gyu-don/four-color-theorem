// 配色。ImageData へ Uint32Array 経由で書き込むため、リトルエンディアンの ABGR 値に変換して使う。

export interface Palette {
  name: string;
  /** 4 色 (CSS の #rrggbb) */
  colors: [string, string, string, string];
}

export const PALETTES: Palette[] = [
  // 落ち着いた地図風の 4 色
  { name: '標準', colors: ['#e9a97f', '#9fcaa0', '#f1d27f', '#92b6dc'] },
  // Okabe–Ito 系(色覚の多様性に配慮した配色)
  { name: '色覚多様性に配慮', colors: ['#e69f00', '#56b4e9', '#f0e442', '#cc79a7'] },
];

/** 色が届いていないセルの灰色 */
export const UNKNOWN_COLOR = '#c4c4c4';
export const BORDER_COLOR = '#2a2a2a';

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** '#rrggbb' → ImageData 用の 32 ビット値 */
export function packColor(hex: string, alpha = 255): number {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return littleEndian
    ? ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
}

/** CSS の rgb(...)/#rrggbb 文字列を '#rrggbb' に揃える(読めなければ fallback) */
export function normalizeCssColor(css: string, fallback: string): string {
  const s = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (!m) return fallback;
  const h = (x: string) => Math.min(255, Number(x)).toString(16).padStart(2, '0');
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

/** 色 hex に色 target を割合 t だけ混ぜる(選択中の領域の強調用) */
export function mixColor(hex: string, target: string, t: number): string {
  const a = parseInt(hex.replace('#', ''), 16);
  const b = parseInt(target.replace('#', ''), 16);
  const ch = (s: number) => {
    const x = (a >> s) & 255;
    const y = (b >> s) & 255;
    return Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
