/**
 * Render CPU + memory ASCII charts from metrics JSON.
 *
 * Usage:
 *   npx tsx chart.ts metrics-*.json
 */

import * as fs from "node:fs/promises";

interface MetricPoint {
  elapsedMs: number;
  cpuPercent: number;
  memUsedMB: number;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx chart.ts <metrics-file.json>");
  process.exit(1);
}

(async () => {
  const raw = await fs.readFile(inputPath, "utf-8");
  const metrics: MetricPoint[] = JSON.parse(raw);

  if (metrics.length === 0) {
    console.log("No metrics data.");
    return;
  }

  const width = 60;
  const cpuMax = Math.max(...metrics.map((m) => m.cpuPercent), 1);
  const memMax = Math.max(...metrics.map((m) => m.memUsedMB), 1);
  const totalSec = (metrics[metrics.length - 1].elapsedMs / 1000).toFixed(0);

  console.log(`\nCPU Usage (0-${Math.round(cpuMax)}%)  —  ${totalSec}s total\n`);

  // Y-axis labels
  for (let row = 10; row >= 0; row--) {
    const pct = Math.round((row / 10) * cpuMax);
    const label = String(pct).padStart(3) + "% │";
    let line = label;
    const step = Math.max(1, Math.floor(metrics.length / width));
    for (let i = 0; i < Math.min(metrics.length, width); i++) {
      const m = metrics[i * step];
      if (!m) continue;
      const val = (m.cpuPercent / cpuMax) * 10;
      line += val >= row ? (val >= row + 0.8 ? "█" : "▄") : " ";
    }
    console.log(line);
  }
  console.log("     └" + "─".repeat(Math.min(width, Math.floor(metrics.length / Math.max(1, Math.floor(metrics.length / width))))));

  console.log(`\nMemory Used (0-${Math.round(memMax)} MB)  —  ${totalSec}s total\n`);

  for (let row = 10; row >= 0; row--) {
    const mb = Math.round((row / 10) * memMax);
    const label = String(mb).padStart(4) + "MB │";
    let line = label;
    const step = Math.max(1, Math.floor(metrics.length / width));
    for (let i = 0; i < Math.min(metrics.length, width); i++) {
      const m = metrics[i * step];
      if (!m) continue;
      const val = (m.memUsedMB / memMax) * 10;
      line += val >= row ? (val >= row + 0.8 ? "█" : "▄") : " ";
    }
    console.log(line);
  }
  console.log("      └" + "─".repeat(Math.min(width, Math.floor(metrics.length / Math.max(1, Math.floor(metrics.length / width))))));

  console.log("");
})();
