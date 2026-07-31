# Regatta

32 Pi agents racing in parallel on Spin — proof of concept for Akamai Functions.

## Quick Start

```bash
npm install
spin build
spin up
```

Test a single agent:

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "find and fix the auth bug", "agentId": "test-01", "llmApiKey": "sk-..."}'
```

## Architecture

```
HTTP POST → Spin Wasm → Agent Loop (5+ turns, 20+ tool calls) → OTel traces
```

| File | Purpose |
|------|---------|
| `src/index.ts` | HTTP handler — receives request, starts agent |
| `src/agent-loop.ts` | Multi-turn agent loop — LLM calls, tool execution, span creation |
| `src/tools.ts` | 6 tool definitions (matching Sail) + simulated execution |
| `src/telemetry.ts` | OpenTelemetry span helpers — traceId, spanId, timing, attributes |

## Load Test

```bash
cd ../load-test
npm install
npm start
```

Fires 32 concurrent requests to `/run`. Validates each agent ran ≥ 5 turns and ≥ 20 tool calls. Prints summary table and saves JSON.

## Observability

```bash
# Start Jaeger + OTel Collector
docker compose -f ../docker-compose.yml up -d

# Run Spin with OTel export
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 spin up

# View traces at http://localhost:16686
```
