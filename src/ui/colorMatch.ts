// 色の安定化: 新しい彩色の 4 色を置換して、前回の彩色と同じ色のままのセルを最大にする。
// DOM 非依存(ワーカーとテストから使う)。

/** 4 色の全置換 24 通り */
const PERMS: Uint8Array[] = (() => {
  const out: Uint8Array[] = [];
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      for (let c = 0; c < 4; c++)
        for (let d = 0; d < 4; d++) {
          if (a === b || a === c || a === d || b === c || b === d || c === d) continue;
          out.push(Uint8Array.of(a, b, c, d));
        }
  return out;
})();

/**
 * perm[新しい色] = 置換後の色 を返す。score = #{i : perm[next[i]] === prev[i]} を最大化する。
 * 4×4 の個数行列を作るだけなので O(n)。長さが違うときは恒等置換。
 */
export function bestPermutation(prev: Uint8Array, next: Uint8Array): Uint8Array {
  if (prev.length !== next.length) return Uint8Array.of(0, 1, 2, 3);
  // count[old*4 + new]
  const count = new Float64Array(16);
  for (let i = 0, n = next.length; i < n; i++) {
    const o = prev[i];
    const c = next[i];
    if (o < 4 && c < 4) count[o * 4 + c]++;
  }
  let best = PERMS[0];
  let bestScore = -1;
  for (const p of PERMS) {
    const s = count[p[0] * 4] + count[p[1] * 4 + 1] + count[p[2] * 4 + 2] + count[p[3] * 4 + 3];
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}

/** colors をその場で置換する */
export function applyPermutation(colors: Uint8Array, perm: Uint8Array): void {
  if (perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && perm[3] === 3) return;
  for (let i = 0, n = colors.length; i < n; i++) {
    const c = colors[i];
    if (c < 4) colors[i] = perm[c];
  }
}
