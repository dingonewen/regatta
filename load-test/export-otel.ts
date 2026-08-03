/**
 * Convert regatta load-test results to standard OTLP JSON trace file.
 *
 * Usage:
 *   npx tsx export-otel.ts results-2026-07-31T19-00-00-000Z.json
 *
 * Output:
 *   traces-<timestamp>.json  —  OTLP-compatible trace file
 */

import * as fs from "node:fs/promises";

interface SpanRecord {
  name: string;
  spanId: string;
  parentSpanId?: string;
  durationMs: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes: Record<string, string | number>;
}

interface AgentResult {
  agentId: string;
  traceId: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  spans: SpanRecord[];
}

interface ResultsFile {
  config: Record<string, unknown>;
  runs?: { agents: AgentResult[] }[];
  results?: AgentResult[]; // legacy single-run format
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx export-otel.ts <results-file.json>");
  process.exit(1);
}

(async () => {
  const raw = await fs.readFile(inputPath, "utf-8");
  const data: ResultsFile = JSON.parse(raw);

  const agents = data.runs
    ? data.runs.flatMap((r) => r.agents)
    : (data.results || []);
  const resourceSpans = agents
    .filter((r: AgentResult) => r.spans && r.spans.length > 0)
    .map((r: AgentResult) => ({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "regatta-agent" } },
          { key: "agent.id", value: { stringValue: r.agentId } },
          { key: "agent.turns", value: { intValue: r.turns } },
          { key: "agent.tool_calls", value: { intValue: r.toolCalls } },
        ],
      },
      scopeSpans: [
        {
          scope: {
            name: "regatta-agent-loop",
            version: "0.1.0",
          },
          spans: r.spans.map((s: SpanRecord) => ({
            traceId: r.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || "",
            name: s.name,
            kind: s.name.startsWith("tool_call") ? 3 : 1, // CLIENT=3, INTERNAL=1
            startTimeUnixNano: s.startTimeUnixNano || "0",
            endTimeUnixNano: s.endTimeUnixNano || "0",
            attributes: Object.entries(s.attributes).map(
              ([k, v]: [string, string | number]) => ({
                key: k,
                value:
                  typeof v === "number"
                    ? { doubleValue: v }
                    : { stringValue: String(v) },
              }),
            ),
            status: s.attributes["error"]
              ? { code: 2, message: String(s.attributes["error"]) }
              : { code: 1 },
          })),
        },
      ],
    }));

  const otelOutput = {
    resourceSpans,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `traces-${ts}.json`;
  await fs.writeFile(outPath, JSON.stringify(otelOutput, null, 2), "utf-8");

  const spanCount = resourceSpans.reduce(
    (sum, rs) => sum + rs.scopeSpans[0].spans.length,
    0,
  );
  console.log(
    `Wrote ${resourceSpans.length} traces (${spanCount} spans total) → ${outPath}`,
  );
})();
