/**
 * HTTP handler — entry point for the regatta agent.
 *
 * POST /run  →  start an agent loop, return trace + result
 * GET  /     →  health check
 */

import { AutoRouter } from "itty-router";
import { runAgentLoop, AgentConfig } from "./agent-loop";
import { Telemetry } from "./telemetry";

const router = AutoRouter();

// ── Health check ──

router.get("/", () => {
  return new Response(
    JSON.stringify({
      service: "regatta-agent",
      version: "0.1.0",
      endpoints: { "POST /run": "Run an agent loop" },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});

// ── Agent run endpoint ──

router.post("/run", async (request: Request) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, {
      error: "Invalid JSON body",
    });
  }

  // Cold-start timestamp: first line after parsing the request body
  const startedAt = Date.now();

  const prompt =
    typeof body.prompt === "string"
      ? body.prompt
      : "Explore the codebase and fix any bugs you find";
  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";

  // Resolve config from request body with fallbacks
  const config: Partial<AgentConfig> = {
    llmEndpoint:
      typeof body.llmEndpoint === "string"
        ? body.llmEndpoint
        : "mock",
    llmApiKey:
      typeof body.llmApiKey === "string" ? body.llmApiKey : "",
    model:
      typeof body.model === "string"
        ? body.model
        : "claude-sonnet-4-5-20250901",
    maxTurns:
      typeof body.maxTurns === "number" ? body.maxTurns : 20,
  };

  const telemetry = new Telemetry();

  try {
    const result = await runAgentLoop(prompt, config, telemetry);

    return jsonResponse(200, {
      agentId,
      startedAt,
      prompt: prompt.slice(0, 200),
      traceId: result.traceId,
      turns: result.turns,
      toolCalls: result.toolCalls,
      finalResponse: result.finalResponse.slice(0, 1000),
      durationMs: result.durationMs,
      spans: result.spans.map((s) => ({
        name: s.name,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        durationMs: Math.round((s.endTime - s.startTime) / 1_000_000 * 100) / 100,
        attributes: truncateAttrs(s.attributes),
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, {
      agentId,
      startedAt,
      error: msg,
      traceId: telemetry.traceId,
      spans: telemetry.getSpans().map((s) => ({
        name: s.name,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        durationMs: s.endTime
          ? (s.endTime - s.startTime) / 1_000_000
          : 0,
        attributes: s.attributes,
      })),
    });
  }
});

// ── 404 handler ──

router.all("*", () => {
  return jsonResponse(404, { error: "Not found. Use POST /run or GET /" });
});

// ── Spin fetch entry point ──

// @ts-ignore — Spin global
addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(router.fetch(event.request));
});

// ── Helpers ──

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function truncateAttrs(
  attrs: Record<string, string | number>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}
