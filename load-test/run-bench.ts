/**
 * Regatta load test: fires N concurrent agent requests, validates results.
 *
 * Usage:
 *   npx tsx run-bench.ts [--count 32] [--endpoint http://localhost:3000/run] [--mock]
 *
 * Each agent must complete ≥ 5 turns and ≥ 20 tool calls.
 * Results saved to ./results-<timestamp>.json
 */

const COUNT = parseInt(argsFlag("count") || "32", 10);
const ENDPOINT = argsFlag("endpoint") || "http://localhost:3000/run";
const MAX_TURNS = parseInt(argsFlag("maxTurns") || "10", 10);
const PROMPT =
  argsFlag("prompt") ||
  "Explore the codebase, find bugs in auth.ts and login.ts, fix them, and verify with tests.";

// ── Types ──

interface AgentResponse {
  agentId: string;
  prompt: string;
  traceId: string;
  turns: number;
  toolCalls: number;
  spans: SpanResult[];
  finalResponse: string;
  durationMs: number;
  error?: string;
}

interface SpanResult {
  name: string;
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  attributes: Record<string, string | number>;
}

interface BenchResult {
  agentId: string;
  status: number;
  traceId: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  error?: string;
  passed: boolean;
}

// ── Main ──

console.log(`\n ⛵ Regatta Load Test`);
console.log(`    agents:  ${COUNT}`);
console.log(`    endpoint: ${ENDPOINT}`);
console.log(`    prompt:  "${PROMPT.slice(0, 60)}..."\n`);

const startTime = Date.now();

// Fire all requests concurrently
const requests = Array.from({ length: COUNT }, (_, i) => {
  const agentId = `agent-${String(i + 1).padStart(2, "0")}`;
  return runAgent(agentId);
});

const results = (await Promise.all(requests)).filter(Boolean) as BenchResult[];
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// ── Validate ──

const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

console.log(`\n ─── Results ───\n`);
console.log(
  ` Total:   ${results.length}/${COUNT} completed in ${elapsed}s`,
);
console.log(` Passed:  ${passed.length}  ✓`);
console.log(` Failed:  ${failed.length}  ${failed.length > 0 ? "✗" : ""}`);

if (failed.length > 0) {
  console.log(`\n Failures:`);
  for (const f of failed) {
    console.log(
      `   ${f.agentId}: ${f.error || `turns=${f.turns} tools=${f.toolCalls}`}`,
    );
  }
}

// ── Stats ──

const durations = results.map((r) => r.durationMs);
const turns = results.map((r) => r.turns);
const toolCalls = results.map((r) => r.toolCalls);

console.log(`\n ─── Metrics ───\n`);
console.log(` Duration:  min ${min(durations)}ms  max ${max(durations)}ms  avg ${avg(durations)}ms`);
console.log(` Turns:     min ${min(turns)}  max ${max(turns)}  avg ${avg(turns)}`);
console.log(` ToolCalls: min ${min(toolCalls)}  max ${max(toolCalls)}  avg ${avg(toolCalls).toFixed(1)}`);

// ── Save results ──

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `./results-${timestamp}.json`;
await writeJson(outPath, {
  config: { count: COUNT, endpoint: ENDPOINT, prompt: PROMPT },
  summary: {
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    elapsedSeconds: parseFloat(elapsed),
  },
  results,
});

console.log(`\n Results saved to ${outPath}`);

if (passed.length > 0) {
  console.log(`\n Traces to inspect:`);
  for (const p of passed.slice(0, 5)) {
    console.log(
      `   ${p.agentId}  trace: ${p.traceId}  (http://localhost:16686/trace/${p.traceId})`,
    );
  }
  if (passed.length > 5) {
    console.log(`   ... and ${passed.length - 5} more`);
  }
}

console.log("");

// ── Agent runner ──

async function runAgent(agentId: string): Promise<BenchResult | null> {
  const body: Record<string, unknown> = {
    agentId,
    prompt: PROMPT,
    model: "claude-sonnet-4-5-20250901",
    maxTurns: MAX_TURNS,
    llmEndpoint: "mock", // default to mock — change for real LLM
  };

  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      agentId,
      status: 0,
      traceId: "",
      turns: 0,
      toolCalls: 0,
      durationMs: Date.now() - start,
      error: `Connection error: ${msg}`,
      passed: false,
    };
  }

  const durationMs = Date.now() - start;
  let data: AgentResponse;
  try {
    data = (await response.json()) as AgentResponse;
  } catch {
    return {
      agentId,
      status: response.status,
      traceId: "",
      turns: 0,
      toolCalls: 0,
      durationMs,
      error: "Invalid JSON response",
      passed: false,
    };
  }

  if (data.error) {
    return {
      agentId,
      status: response.status,
      traceId: data.traceId || "",
      turns: data.turns || 0,
      toolCalls: data.toolCalls || 0,
      durationMs,
      error: data.error,
      passed: false,
    };
  }

  const passed =
    response.status === 200 &&
    data.turns >= 5 &&
    data.toolCalls >= 20 &&
    /^[0-9a-f]{32}$/.test(data.traceId);

  return {
    agentId,
    status: response.status,
    traceId: data.traceId,
    turns: data.turns,
    toolCalls: data.toolCalls,
    durationMs,
    passed,
    error: passed
      ? undefined
      : [
          response.status !== 200 && `status=${response.status}`,
          data.turns < 5 && `turns=${data.turns} (<5)`,
          data.toolCalls < 20 && `toolCalls=${data.toolCalls} (<20)`,
          !/^[0-9a-f]{32}$/.test(data.traceId) && `invalid traceId`,
        ]
          .filter(Boolean)
          .join(", "),
  };
}

// ── Helpers ──

function min(arr: number[]): number {
  return arr.length ? Math.min(...arr) : 0;
}
function max(arr: number[]): number {
  return arr.length ? Math.max(...arr) : 0;
}
function avg(arr: number[]): number {
  return arr.length
    ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
    : 0;
}

function argsFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

async function writeJson(
  path: string,
  data: unknown,
): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}
