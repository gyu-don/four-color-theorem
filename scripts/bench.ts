// ソルバ単体のベンチマーク: node --import tsx scripts/bench.ts [uniform|jitter|hex] [セル数...]
import Delaunator from 'delaunator';
import { FourColorSolver } from '../src/core/index';
import { buildRegionGraph } from '../src/map/regionGraph';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePoints(kind: string, n: number, seed: number): Float64Array {
  const r = rng(seed);
  const pts: number[] = [];
  if (kind === 'uniform') {
    for (let i = 0; i < n; i++) pts.push(r(), r());
  } else {
    const jit = kind === 'hex' ? 0.02 : 0.35;
    const s = Math.sqrt(2 / (Math.sqrt(3) * n));
    const rows = Math.round(1 / (s * Math.sqrt(3) / 2));
    const cols = Math.round(1 / s);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        pts.push((x + (y & 1) * 0.5 + (r() * 2 - 1) * jit) * s, (y + (r() * 2 - 1) * jit) * s * Math.sqrt(3) / 2);
      }
    }
  }
  // 局所性のため格子順に並べ替える
  const m = pts.length / 2;
  const g = Math.max(1, Math.round(Math.sqrt(m / 4)));
  const key = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const gx = Math.min(g - 1, Math.max(0, Math.floor(pts[2 * i] * g)));
    const gy = Math.min(g - 1, Math.max(0, Math.floor(pts[2 * i + 1] * g)));
    key[i] = gy * g + (gy & 1 ? g - 1 - gx : gx);
  }
  const idx = Array.from({ length: m }, (_, i) => i).sort((a, b) => key[a] - key[b]);
  const out = new Float64Array(2 * m);
  idx.forEach((j, i) => {
    out[2 * i] = pts[2 * j];
    out[2 * i + 1] = pts[2 * j + 1];
  });
  return out;
}

async function main(): Promise<void> {
  const kind = process.argv[2] ?? 'uniform';
  const sizes = process.argv.slice(3).map(Number);
  if (sizes.length === 0) sizes.push(10000, 100000);
  const t0 = performance.now();
  const solver = await FourColorSolver.create();
  console.log(`library: ${solver.configCount} configs, ${(performance.now() - t0).toFixed(0)} ms`);
  for (const n of sizes) {
    const pts = makePoints(kind, n, 12345);
    const d = new Delaunator(pts);
    const tri = { numCells: pts.length / 2, triangles: d.triangles, halfedges: d.halfedges };
    const labels = new Int32Array(tri.numCells);
    for (let i = 0; i < labels.length; i++) labels[i] = i;
    const tg = performance.now();
    const rg = buildRegionGraph(tri, labels);
    const msGraph = performance.now() - tg;
    for (let rep = 0; rep < 2; rep++) {
      const res = solver.solve(rg.graph, { verify: true, kempeMode: (process.env.KEMPE as 'greedy' | 'random') ?? 'greedy' });
      const s = res.stats;
      console.log(
        `${kind} n=${s.n} graph=${msGraph.toFixed(0)}ms total=${s.msTotal.toFixed(0)}ms (tri ${s.msTriangulate.toFixed(0)}, reduce ${s.msReduce.toFixed(0)} [match ${s.msMatch.toFixed(0)}], extend ${s.msExtend.toFixed(0)}) ` +
          `levels=${s.levels} deg3=${s.configsDeg3} deg4=${s.configsDeg4} D=${s.configsD} (${s.distinctD} kinds) ` +
          `passes=${s.kempePasses} maxPass=${s.maxPassesPerLevel} flipped=${s.kempeFlipped} explored=${s.kempeExplored} fallback=${s.fallbackVertices}`,
      );
    }
  }
}

if (process.argv[1]?.endsWith('bench.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
