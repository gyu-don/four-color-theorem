// ランダムな地図を大量に解いて検証する: node --import tsx scripts/fuzz.ts [回数] [最大セル数]
import { FourColorSolver } from '../src/core/index';
import { generateMap } from '../src/map/generate';
import { buildRegionGraph } from '../src/map/regionGraph';
import type { Distribution } from '../src/protocol';

async function main(): Promise<void> {
  const runs = +(process.argv[2] ?? 500);
  const maxCells = +(process.argv[3] ?? 4000);
  const solver = await FourColorSolver.create();
  const dists: Distribution[] = ['uniform', 'jitter', 'hex'];
  let fallbackRuns = 0, fallbackVerts = 0, maxPass = 0, dUsed = 0;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    const seed = i + 1;
    const numCells = 16 + Math.floor(((seed * 2654435761) >>> 0) / 4294967296 * (maxCells - 16));
    const cellsPerRegion = [1, 1, 1, 2, 3, 5, 8, 20][i % 8];
    const distribution = dists[i % 3];
    const m = generateMap({ numCells, distribution, cellsPerRegion, seed, aspect: 1.3 });
    // 乱暴な編集: ランダムな円の中を 1 つの領域にする(穴・飛び地・分断が起きる)
    const labels = m.labels.slice();
    if (i % 2 === 1) {
      let s = seed * 7919;
      const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
      for (let k = 0; k < 3; k++) {
        const cx = rnd() * 1.3, cy = rnd(), r = 0.05 + rnd() * 0.25, lab = 1_000_000 + k;
        const ring = rnd() < 0.5;
        for (let c = 0; c < labels.length; c++) {
          const dd = Math.hypot(m.points[2 * c] - cx, m.points[2 * c + 1] - cy);
          if (dd < r && (!ring || dd > r * 0.6)) labels[c] = lab;
        }
      }
    }
    const rg = buildRegionGraph(m.tri, labels);
    for (const identifyDegree4 of [true, false]) {
      for (const kempeMode of ['greedy', 'random'] as const) {
        try {
          const res = solver.solve(rg.graph, { verify: true, seed, identifyDegree4, kempeMode });
          if (res.stats.fallbackVertices > 0) {
            fallbackRuns++;
            fallbackVerts += res.stats.fallbackVertices;
            console.log(`fallback: run ${i} cells=${numCells} ${distribution} cpr=${cellsPerRegion} n=${res.stats.n} identify=${identifyDegree4} ${kempeMode}: ${res.stats.fallbackVertices} vertices`);
          }
          maxPass = Math.max(maxPass, res.stats.maxPassesPerLevel);
          dUsed += res.stats.configsD;
        } catch (e) {
          console.error(`FAILED: run ${i} cells=${numCells} ${distribution} cpr=${cellsPerRegion} identify=${identifyDegree4} ${kempeMode}`);
          throw e;
        }
      }
    }
  }
  console.log(`${runs} maps x 4 settings OK in ${((performance.now() - t0) / 1000).toFixed(1)} s; fallback runs=${fallbackRuns} (vertices ${fallbackVerts}), max passes/level=${maxPass}, D configs used=${dUsed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
