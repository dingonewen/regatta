# Regatta

**32 Pi agents racing in parallel on Spin** — proof of concept for Akamai Functions.

Spawns 16–32 concurrent agent environments, each running a multi-turn tool-calling loop (≥ 5 turns, ≥ 20 tool calls), with per-agent cold-start measurement, CPU/memory monitoring, and OpenTelemetry trace export.

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
  → N concurrent (or staggered) HTTP POST → Spin Wasm instances
    → src/index.ts → AgentLoop.run(prompt)
      → Turn 1..N: LLM API → tool_calls → execute → repeat
      → Return { traceId, turns, toolCalls, spans[] (with LLM request/response + tool args/output) }
  → Auto-generates: results-*.json, stats-*.json, metrics-*.json, traces-*.json
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
│   ├── run-bench.ts        # Benchmark runner (concurrent or staggered)
│   ├── export-otel.ts      # Results → OTLP JSON trace file
│   ├── chart.ts            # ASCII CPU/memory charts
│   └── latest.ts           # Quick cold-start breakdown
├── docker-compose.yml      # Jaeger + OTel Collector (local o11y)
└── otel-collector-config.yaml
```

## Load Test

```bash
cd load-test
npm install

# Mock mode (fast, no API cost)
npm start

# Real LLM
npm start -- --llmEndpoint "https://api.deepseek.com/v1/chat/completions" \
             --llmApiKey "sk-..." \
             --model "deepseek-chat"

# Staggered (one agent per second, for cold-start comparison)
npm start -- --stagger 1000 --llmEndpoint "..." --llmApiKey "..." --model "deepseek-chat"
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--count N` | 32 | Number of agents per run |
| `--runs N` | 1 | Number of consecutive rounds |
| `--stagger N` | 0 | Milliseconds between each agent launch (0 = all at once) |
| `--llmEndpoint` | mock | LLM API URL, or "mock" |
| `--llmApiKey` | "" | API key |
| `--model` | deepseek-chat | Model name |
| `--prompt` | (see code) | User prompt |

Each run outputs four files:

| File | Content |
|------|---------|
| `results-*.json` | Per-agent raw data (cold-start, turns, toolCalls, spans) |
| `stats-*.json` | Aggregated avg/median/P99/distribution for cold-start and end-to-end |
| `metrics-*.json` | CPU + memory time series (sampled every 500ms) |
| `traces-*.json` | Standard OTLP JSON trace file with full span hierarchy |

### Viewing Results

```bash
npm run latest           # Cold-start breakdown for the latest run
npm run chart metrics-*.json   # ASCII CPU + memory time-series charts
```

## Cold-Start Findings

| Launch Mode | Agent-01 | Agents 02–32 | Total Elapsed |
|-------------|----------|--------------|---------------|
| Concurrent (32 at once) | ~0ms | 2–32ms | ~60–85s |
| Staggered (1/sec) | ~0ms | ~0ms | ~110s |

When requests arrive simultaneously, all agents share the Wasm instantiation cost. With staggered launch, only the first request pays it — the remaining 31 reuse the already-warm module.

## Traces

Each OTel trace includes per-span content for every LLM call and tool execution:

- `model_turn`: `llm.request`, `llm.response_text`, `llm.response_tool_names`, token counts, timing
- `tool_call:<name>`: `tool.arguments`, `tool.result`, timing

Standard OTLP JSON — importable into Jaeger, Grafana Tempo, or Logfire for waterfall visualization.

## Supported LLM Providers

| Provider | API Format |
|----------|------------|
| Anthropic | Messages API |
| DeepSeek, OpenAI, Groq | Chat Completions (OpenAI-compatible) |

Auto-detected from endpoint URL.

## Deployment & Cost

### Fermyon Cloud ([pricing](https://www.fermyon.com/pricing))
- **Starter (free):** 5 apps, 100K requests/month — a 32-agent benchmark uses 32 requests per run. Even at 100 runs/day, you'd stay well within the free tier.
- **Growth ($19.38/month):** 100 apps, 1M requests/month.

### Akamai Functions
Still in public preview — no published pricing. Akamai's edge products are typically enterprise contract-based. Contact their sales team for a quote.

### Real Cost: the LLM
Spin hosting is negligible. The dominant cost is the LLM API. A 32-agent DeepSeek run costs ~$0.02–0.05. Even at 10 runs/day, that's <$15/month.

## License

MIT
