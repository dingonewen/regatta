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
      typeof body.maxTurns === "number" ? body.maxTurns : 7,
  };

  const telemetry = new Telemetry();

  try {
    const result = await runAgentLoop(prompt, config, telemetry);

    return jsonResponse(200, {
      agentId,
      prompt: prompt.slice(0, 200),
      ...result,
      spans: result.spans.map((s) => ({
        name: s.name,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        durationMs: (s.endTime - s.startTime) / 1_000_000,
        attributes: s.attributes,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, {
      agentId,
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
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
