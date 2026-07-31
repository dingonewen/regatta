# Regatta Agent

Spin TypeScript component — multi-turn agent loop with OpenTelemetry tracing.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `POST` | `/run` | Run an agent loop |

## POST /run

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"agentId":"test","prompt":"find bugs in auth.ts"}' | python3 -m json.tool
```

### Request body

| Field | Default | Description |
|-------|---------|-------------|
| `agentId` | `"unknown"` | Agent identifier |
| `prompt` | (see code) | User prompt to the agent |
| `llmEndpoint` | `"mock"` | LLM API URL, or `"mock"` for simulated responses |
| `llmApiKey` | `""` | API key (required for real LLM) |
| `model` | `"deepseek-chat"` | Model name |
| `maxTurns` | `20` | Maximum conversation turns |

### Response

```json
{
  "agentId": "test",
  "traceId": "dd847012ebf63cba6913088c52033cdf",
  "turns": 6,
  "toolCalls": 24,
  "finalResponse": "Analysis complete...",
  "durationMs": 8672,
  "spans": [
    {
      "name": "agent_run",
      "spanId": "2c47fe4f005ed7c6",
      "durationMs": 3.96,
      "attributes": { "agent.total_turns": 6, "agent.total_tool_calls": 24 }
    }
  ]
}
```

## Tools

Same tool set as Sail: `read_file`, `grep`, `write_file`, `edit_file`, `execute_command`, `web_fetch`.

Mock mode returns realistic simulated results. Real LLM mode executes the agent loop but tools remain simulated (no actual filesystem in Wasm).
