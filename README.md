# Regatta

**32 Pi agents racing in parallel on Spin** — proof of concept for Akamai Functions.

Spawns 16–32 concurrent agent environments, each running a multi-turn tool-calling loop (≥ 5 turns, ≥ 20 tool calls), then exports an OpenTelemetry trace file.

Built on [Spin](https://spinframework.dev/) (WebAssembly serverless framework) in TypeScript.

## Quick Start

```bash
cd regatta-agent
npm install
spin build
spin up
```

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"agentId":"test","prompt":"find bugs in auth.ts"}' | python3 -m json.tool | head -10
```

Default is mock mode — no API key needed. Switch to real LLM by passing `llmEndpoint` and `llmApiKey` in the request body.

## Architecture

```
load-test/run-bench.ts
  → 32 concurrent HTTP POST → Spin Wasm instances (one per request)
    → src/index.ts → AgentLoop.run(prompt)
      → Turn 1..N: LLM API → tool_calls → execute → repeat
      → Return { traceId, turns, toolCalls, spans[] }
  → export-otel.ts → traces-*.json (OTLP format)
```

## Project Structure

```
regatta/
├── regatta-agent/          # Spin TypeScript application
│   ├── spin.toml           # Spin manifest (routes, outbound hosts)
│   ├── package.json
│   ├── build.mjs           # esbuild + jco → .wasm
│   └── src/
│       ├── index.ts        # HTTP handler
│       ├── agent-loop.ts   # Multi-turn agent state machine
│       ├── tools.ts        # 6 tool definitions + simulated execution
│       └── telemetry.ts    # OTel span tracking
├── load-test/              # Concurrency benchmark harness
│   ├── run-bench.ts        # Fires N concurrent requests, validates results
│   └── export-otel.ts      # Converts results → OTLP JSON trace file
├── docker-compose.yml      # Jaeger + OTel Collector (local o11y)
└── otel-collector-config.yaml
```

## Run the Load Test

```bash
# Mock mode (fast, no API cost)
cd load-test
npm install && npm start

# Real LLM (DeepSeek, OpenAI, etc.)
npm start -- --llmEndpoint "https://api.deepseek.com/v1/chat/completions" \
             --llmApiKey "sk-..." \
             --model "deepseek-chat"
```

## Export OTel Trace File

```bash
cd load-test
npx tsx export-otel.ts results-*.json
# → traces-*.json (standard OTLP JSON, importable into Jaeger/Grafana/Logfire)
```

## Supported Providers

| Provider | API Format |
|----------|------------|
| Anthropic | Messages API |
| DeepSeek, OpenAI, Groq | Chat Completions (OpenAI-compatible) |

Auto-detected from endpoint URL (`anthropic` in host → Anthropic format, otherwise OpenAI format).

## License

MIT
