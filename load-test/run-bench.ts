/**
 * Regatta load test: concurrent agent benchmark with CPU/memory monitoring.
 *
 * Usage:
 *   npx tsx run-bench.ts [--count 32] [--runs 5] [--mock]
 *        [--llmEndpoint URL] [--llmApiKey KEY] [--model NAME]
 *
 * Outputs:
 *   results-<ts>.json  — per-agent raw data
 *   metrics-<ts>.json  — CPU + memory time series
 *   stats-<ts>.json    — avg/median/P99/distribution for cold-start and e2e
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";

const COUNT = parseInt(argsFlag("count") || "32", 10);
const RUNS = parseInt(argsFlag("runs") || "1", 10);
const ENDPOINT = argsFlag("endpoint") || "http://localhost:3000/run";
const MAX_TURNS = parseInt(argsFlag("maxTurns") || "20", 10);
const LLM_ENDPOINT = argsFlag("llmEndpoint") || "mock";
const LLM_API_KEY = argsFlag("llmApiKey") || "";
const LLM_MODEL = argsFlag("model") || "deepseek-chat";
const PROMPT =
  argsFlag("prompt") ||
  "Explore the codebase, find bugs in auth.ts and login.ts, fix them, and verify with tests.";

// ── Types ──

interface AgentResult {
  agentId: string;
  startedAt?: number;
  traceId: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  error?: string;
  passed: boolean;
}

interface MetricPoint {
  elapsedMs: number;
  cpuPercent: number;
  memUsedMB: number;
}

interface FullResult {
  config: Record<string, unknown>;
  runs: RunResult[];
}

interface RunResult {
  round: number;
  elapsedMs: number;
  agents: AgentResult[];
}

// ── Main ──

const ts = new Date().toISOString().replace(/[:.]/g, "-");

console.log(`\n ⛵ Regatta Load Test`);
console.log(`    agents:  ${COUNT}`);
console.log(`    runs:    ${RUNS}`);
console.log(`    llm:     ${LLM_ENDPOINT}`);
console.log(`    model:   ${LLM_MODEL}`);
console.log(`    prompt:  "${PROMPT.slice(0, 60)}..."\n`);

// Start metrics collector
const collector = startMetricsCollector(500); // sample every 500ms
const startTime = Date.now();

const allRuns: RunResult[] = [];

for (let round = 0; round < RUNS; round++) {
  console.log(`─── Round ${round + 1}/${RUNS} ───`);
  const roundStart = Date.now();

  const requests = Array.from({ length: COUNT }, (_, i) => {
    const agentId = `r${round + 1}-${String(i + 1).padStart(2, "0")}`;
    return runAgent(agentId);
  });

  const agents = (await Promise.all(requests)).filter(Boolean) as AgentResult[];
  const roundElapsed = Date.now() - roundStart;
  allRuns.push({ round: round + 1, elapsedMs: roundElapsed, agents });

  const passed = agents.filter((r) => r.passed).length;
  console.log(`    ${passed}/${COUNT} passed in ${(roundElapsed / 1000).toFixed(1)}s\n`);
}

const totalElapsed = Date.now() - startTime;

// Stop collector
const metrics = stopMetricsCollector(collector, totalElapsed);

// ── Save raw results ──

const allAgents = allRuns.flatMap((r) => r.agents);

const resultsPayload: FullResult = {
  config: { count: COUNT, runs: RUNS, maxTurns: MAX_TURNS, llmEndpoint: LLM_ENDPOINT, model: LLM_MODEL },
  runs: allRuns,
};
await fs.writeFile(`results-${ts}.json`, JSON.stringify(resultsPayload, null, 2), "utf-8");
console.log(`Results saved → results-${ts}.json`);

await fs.writeFile(`metrics-${ts}.json`, JSON.stringify(metrics, null, 2), "utf-8");
console.log(`Metrics saved → metrics-${ts}.json`);

// ── Compute statistics ──

const coldStarts = allAgents
  .filter((a) => a.startedAt != null && a.durationMs != null)
  .map((a) => a.startedAt! - (allRuns.find((r) => r.agents.includes(a))?.agents[0]?.startedAt || a.startedAt!));

// Cold start: calculate from the load-test side (response.startedAt - request.sentAt)
// We don't have request.sentAt directly, so we use a different approach:
// The agent's startedAt timestamp represents when the handler received the request.
// Cold start ≈ (the agent's startedAt relative to the first agent in the same round)

const e2eDurations = allAgents
  .filter((a) => a.passed)
  .map((a) => a.durationMs);

// For cold start, we use the delta between agent.startedAt and the round's earliest startedAt
const coldStartValues: number[] = [];
for (const run of allRuns) {
  const starts = run.agents
    .filter((a) => a.startedAt != null)
    .map((a) => a.startedAt!);
  if (starts.length < 2) continue;
  const base = Math.min(...starts);
  for (const s of starts) {
    coldStartValues.push(s - base);
  }
}

const stats = {
  coldStart: computeStats(coldStartValues, [0, 1, 2, 5, 10, 20, 50, 100]),
  endToEnd: computeStats(e2eDurations, [5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 60000]),
  runs: RUNS,
  agentsPerRun: COUNT,
  totalAgents: allAgents.length,
  passed: allAgents.filter((a) => a.passed).length,
  failed: allAgents.filter((a) => !a.passed).length,
  totalElapsedMs: totalElapsed,
};

await fs.writeFile(`stats-${ts}.json`, JSON.stringify(stats, null, 2), "utf-8");
console.log(`Stats saved → stats-${ts}.json`);

// ── Print summary ──

console.log(`\n━━━ Statistics ━━━\n`);
console.log(` Total: ${allAgents.length} agents across ${RUNS} runs (${(totalElapsed / 1000).toFixed(1)}s)`);
console.log(` Pass:  ${stats.passed}  |  Fail: ${stats.failed}`);

console.log(`\n Cold Start (ms):`);
console.log(`   avg=${stats.coldStart.avg}  median=${stats.coldStart.median}  p99=${stats.coldStart.p99}  min=${stats.coldStart.min}  max=${stats.coldStart.max}`);
printDist("   ", stats.coldStart.distribution);

console.log(`\n End-to-End (ms):`);
console.log(`   avg=${stats.endToEnd.avg}  median=${stats.endToEnd.median}  p99=${stats.endToEnd.p99}  min=${stats.endToEnd.min}  max=${stats.endToEnd.max}`);
printDist("   ", stats.endToEnd.distribution);

console.log(`\n CPU: avg ${metrics.length ? avg(metrics.map((m) => m.cpuPercent)) : 0}%  |  peak ${metrics.length ? max(metrics.map((m) => m.cpuPercent)) : 0}%`);
console.log(` Mem: avg ${metrics.length ? avg(metrics.map((m) => m.memUsedMB)) : 0} MB  |  peak ${metrics.length ? max(metrics.map((m) => m.memUsedMB)) : 0} MB`);
console.log("");

// ── Agent runner ──

async function runAgent(agentId: string): Promise<AgentResult> {
  const requestSentAt = Date.now();
  const body: Record<string, unknown> = {
    agentId,
    prompt: PROMPT,
    model: LLM_MODEL,
    maxTurns: MAX_TURNS,
    llmEndpoint: LLM_ENDPOINT,
    llmApiKey: LLM_API_KEY,
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { agentId, traceId: "", turns: 0, toolCalls: 0, durationMs: Date.now() - requestSentAt, error: msg, passed: false };
  }

  let data: Record<string, unknown> = {};
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    return { agentId, traceId: "", turns: 0, toolCalls: 0, durationMs: Date.now() - requestSentAt, error: "invalid json", passed: false };
  }

  if (data.error) {
    return {
      agentId,
      startedAt: data.startedAt as number,
      traceId: (data.traceId as string) || "",
      turns: (data.turns as number) || 0,
      toolCalls: (data.toolCalls as number) || 0,
      durationMs: (data.durationMs as number) || Date.now() - requestSentAt,
      error: data.error as string,
      passed: false,
    };
  }

  const turns = (data.turns as number) || 0;
  const toolCalls = (data.toolCalls as number) || 0;
  const traceId = (data.traceId as string) || "";

  return {
    agentId,
    startedAt: data.startedAt as number,
    traceId,
    turns,
    toolCalls,
    durationMs: (data.durationMs as number) || Date.now() - requestSentAt,
    passed: turns >= 5 && toolCalls >= 20 && /^[0-9a-f]{32}$/.test(traceId),
  };
}

// ── Metrics collector ──

interface MetricsCollector {
  interval: ReturnType<typeof setInterval>;
  samples: { elapsedMs: number; cpu: ReturnType<typeof sampleCpu>; mem: ReturnType<typeof sampleMem> };
  stop: () => MetricPoint[];
}

function startMetricsCollector(intervalMs: number): { stop: () => MetricPoint[] } {
  const samples: { elapsedMs: number; cpu: ReturnType<typeof sampleCpu>; mem: ReturnType<typeof sampleMem> }[] = [];
  const started = Date.now();
  let prevCpu = sampleCpu();
  let prevCpuTime = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const curCpu = sampleCpu();
    const cpuDelta = curCpu ? calcCpuPercent(prevCpu, curCpu, now - prevCpuTime) : 0;
    prevCpu = curCpu;
    prevCpuTime = now;
    samples.push({
      elapsedMs: now - started,
      cpu: cpuDelta,
      mem: sampleMem(),
    });
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      return samples.map((s) => ({
        elapsedMs: s.elapsedMs,
        cpuPercent: typeof s.cpu === "number" ? Math.round(s.cpu * 10) / 10 : 0,
        memUsedMB: s.mem,
      }));
    },
  };
}

function stopMetricsCollector(c: { stop: () => MetricPoint[] }, totalElapsedMs: number): MetricPoint[] {
  return c.stop();
}

type CpuSample = { user: number; nice: number; system: number; idle: number; iowait: number; irq: number; softirq: number; steal: number };

function sampleCpu(): CpuSample | null {
  try {
    const raw = execSync("cat /proc/stat | head -1", { encoding: "utf-8", timeout: 2000 });
    const parts = raw.trim().split(/\s+/).slice(1, 9).map(Number);
    return { user: parts[0], nice: parts[1], system: parts[2], idle: parts[3], iowait: parts[4], irq: parts[5], softirq: parts[6], steal: parts[7] };
  } catch {
    return null;
  }
}

function calcCpuPercent(prev: CpuSample | null, cur: CpuSample | null, elapsedMs: number): number {
  if (!prev || !cur) return 0;
  const prevTotal = prev.user + prev.nice + prev.system + prev.idle + prev.iowait + prev.irq + prev.softirq + prev.steal;
  const curTotal = cur.user + cur.nice + cur.system + cur.idle + cur.iowait + cur.irq + cur.softirq + cur.steal;
  const totalDelta = curTotal - prevTotal;
  const idleDelta = cur.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function sampleMem(): number {
  try {
    const raw = execSync("cat /proc/meminfo | grep -E '^(MemTotal|MemAvailable)'", { encoding: "utf-8", timeout: 2000 });
    const lines = raw.trim().split("\n");
    const total = parseInt(lines[0].match(/\d+/)![0], 10);
    const avail = parseInt(lines[1].match(/\d+/)![0], 10);
    return Math.round((total - avail) / 1024 * 10) / 10; // MB used
  } catch {
    return 0;
  }
}

// ── Statistics ──

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function computeStats(values: number[], buckets: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const dist: Record<string, number> = {};
  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1] ?? Infinity;
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
    dist[label] = sorted.filter((v) => v >= lo && v < hi).length;
  }
  return {
    count: sorted.length,
    min: sorted[0] || 0,
    max: sorted[sorted.length - 1] || 0,
    avg: Math.round(avg(sorted)),
    median: Math.round(percentile(sorted, 50)),
    p99: Math.round(percentile(sorted, 99)),
    distribution: dist,
  };
}

function printDist(indent: string, dist: Record<string, number>) {
  for (const [bucket, count] of Object.entries(dist)) {
    if (count > 0) console.log(`${indent}${bucket}ms: ${count}`);
  }
}

// ── Helpers ──

function min(arr: number[]): number {
  return arr.length ? Math.min(...arr) : 0;
}
function max(arr: number[]): number {
  return arr.length ? Math.max(...arr) : 0;
}
function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function argsFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}
