/**
 * Multi-turn agent loop — the core engine.
 *
 * Pattern (same as Sail's controller):
 *   1. Send messages + tool defs to LLM
 *   2. LLM returns text (done) or tool_calls (continue)
 *   3. If tool_calls: execute each, record results, loop back to 1
 *   4. Stop when LLM returns text or max turns reached
 *
 * Supports two modes:
 *   - "mock": simulated LLM responses (no API key needed, for testing)
 *   - anything else: real Anthropic-compatible API calls
 */

import { TOOLS, ToolCall, ToolResult, executeTool } from "./tools";
import { Telemetry } from "./telemetry";

// ── Helpers ──

/** Spin JS runtime lacks crypto — Math.random fallback for IDs */
function randomHex(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ── Types ──

export interface AgentConfig {
  /** LLM API endpoint. Set to "mock" for simulated responses. */
  llmEndpoint: string;
  /** API key (ignored in mock mode) */
  llmApiKey: string;
  /** Model name passed to the LLM */
  model: string;
  /** Maximum conversation turns before forced stop */
  maxTurns: number;
  /** System prompt for the agent */
  systemPrompt: string;
}

export interface AgentResult {
  traceId: string;
  turns: number;
  toolCalls: number;
  spans: ReturnType<Telemetry["getSpans"]>;
  finalResponse: string;
  durationMs: number;
}

// ── System prompt ──

const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent. Your job is to explore a codebase, find bugs, " +
  "and apply fixes. Use the available tools to read files, search for patterns, " +
  "edit code, run commands, and fetch web resources. After each tool result, " +
  "decide whether you need more information or are ready to summarize your findings. " +
  "When you have completed your analysis, respond with a text summary — do not " +
  "call tools in the same turn as your final answer.";

// ── Message types (Anthropic-compatible) ──

interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// ── Main loop ──

export async function runAgentLoop(
  userPrompt: string,
  config: Partial<AgentConfig> = {},
  telemetry: Telemetry,
): Promise<AgentResult> {
  const startTime = Date.now();

  const resolved: AgentConfig = {
    llmEndpoint: config.llmEndpoint || "https://api.anthropic.com/v1/messages",
    llmApiKey: config.llmApiKey || "",
    model: config.model || "claude-sonnet-4-5-20250901",
    maxTurns: config.maxTurns || 7,
    systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
  };

  const isMock = resolved.llmEndpoint === "mock";

  // Message history — system prompt is prepended as first user message
  // (Anthropic API expects system as a top-level param, handled in callLLM)
  const messages: Message[] = [
    { role: "user", content: userPrompt },
  ];

  let turnCount = 0;
  let toolCallCount = 0;
  let finalResponse = "";

  const rootSpanId = telemetry.startSpan("agent_run", undefined, {
    "agent.prompt": userPrompt.slice(0, 200),
    "agent.max_turns": resolved.maxTurns,
    "agent.mock_mode": isMock,
  });

  for (let turn = 0; turn < resolved.maxTurns; turn++) {
    turnCount = turn + 1;

    // ── Call LLM ──
    const turnSpanId = telemetry.startSpan("model_turn", rootSpanId, {
      "turn.number": turnCount,
      "turn.message_count": messages.length,
    });

    let llmResponse: {
      text: string | null;
      toolCalls: ToolCall[];
      usage: { input: number; output: number };
    };

    const llmStart = Date.now();
    try {
      llmResponse = isMock
        ? mockLLMResponse(turn, messages, resolved)
        : resolved.llmEndpoint.includes("anthropic")
          ? await callAnthropic(messages, resolved)
          : await callOpenAI(messages, resolved);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry.failSpan(turnSpanId, msg);
      telemetry.failSpan(rootSpanId, msg);
      return {
        traceId: telemetry.traceId,
        turns: turnCount,
        toolCalls: toolCallCount,
        spans: telemetry.getSpans(),
        finalResponse: `LLM error on turn ${turnCount}: ${msg}`,
        durationMs: Date.now() - startTime,
      };
    }
    const llmDurationMs = Date.now() - llmStart;

    telemetry.endSpan(turnSpanId, {
      "llm.duration_ms": llmDurationMs,
      "llm.model": resolved.model,
      "llm.input_tokens": llmResponse.usage.input,
      "llm.output_tokens": llmResponse.usage.output,
      "turn.tool_calls_count": llmResponse.toolCalls.length,
    });

    // ── Add assistant message to history ──
    messages.push({
      role: "assistant",
      content: llmResponse.text || "",
      tool_calls: llmResponse.toolCalls,
    });

    // ── Check termination: LLM returned text without tool calls ──
    if (llmResponse.toolCalls.length === 0) {
      finalResponse = llmResponse.text || "(empty response)";
      break;
    }

    // ── Execute tool calls ──
    const toolResults: Message[] = [];
    for (const tc of llmResponse.toolCalls) {
      toolCallCount++;

      const toolSpanId = telemetry.startSpan(
        `tool_call:${tc.function.name}`,
        turnSpanId,
        {
          "tool.name": tc.function.name,
          "tool.call_id": tc.id,
        },
      );

      const result = executeTool(tc);
      const toolResult: Message = {
        role: "tool",
        content: result.content,
        tool_call_id: tc.id,
      };
      toolResults.push(toolResult);

      telemetry.endSpan(toolSpanId, {
        "tool.name": tc.function.name,
        "tool.result_length": result.content.length,
      });
    }

    // ── Add tool results to history ──
    messages.push(...toolResults);
  }

  // ── Max turns reached without final text ──
  if (!finalResponse) {
    finalResponse = `Reached max turns (${resolved.maxTurns}) without completion.`;
  }

  telemetry.endSpan(rootSpanId, {
    "agent.total_turns": turnCount,
    "agent.total_tool_calls": toolCallCount,
  });

  return {
    traceId: telemetry.traceId,
    turns: turnCount,
    toolCalls: toolCallCount,
    spans: telemetry.getSpans(),
    finalResponse,
    durationMs: Date.now() - startTime,
  };
}

// ── Real LLM call (Anthropic Messages API) ──

async function callAnthropic(
  messages: Message[],
  config: AgentConfig,
): Promise<{
  text: string | null;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}> {
  // Convert our message format to Anthropic API format
  const apiMessages: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      apiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content && msg.content !== "") {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
      }
      apiMessages.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      apiMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
    }
  }

  const body = {
    model: config.model,
    max_tokens: 1024,
    system: config.systemPrompt,
    messages: apiMessages,
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  };

  const response = await fetch(config.llmEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.llmApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API ${response.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content: ContentBlock[];
    usage: { input_tokens: number; output_tokens: number };
  };

  // Parse response content blocks
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const block of data.content) {
    if (block.type === "text" && block.text) {
      text = (text || "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id || `mock-${randomHex(8)}`,
        type: "function",
        function: {
          name: block.name || "unknown",
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  return {
    text,
    toolCalls,
    usage: {
      input: data.usage?.input_tokens || 0,
      output: data.usage?.output_tokens || 0,
    },
  };
}

// ── Real LLM call (OpenAI-compatible API — DeepSeek, Groq, OpenAI) ──

async function callOpenAI(
  messages: Message[],
  config: AgentConfig,
): Promise<{
  text: string | null;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}> {
  // Convert to OpenAI Chat Completions format
  const apiMessages: unknown[] = [
    { role: "system", content: config.systemPrompt },
  ];
  for (const msg of messages) {
    if (msg.role === "user") {
      apiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant" };
      if (msg.content && msg.content !== "") {
        entry.content = msg.content;
      } else {
        entry.content = null;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        entry.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      apiMessages.push(entry);
    } else if (msg.role === "tool") {
      apiMessages.push({
        role: "tool",
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      });
    }
  }

  const body = {
    model: config.model,
    max_tokens: 1024,
    messages: apiMessages,
    tools: TOOLS.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  };

  const response = await fetch(config.llmEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API ${response.status}: ${errText.slice(0, 500)}`);
  }

  // OpenAI format: { choices: [{ message: { content, tool_calls } }], usage }
  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const choice = data.choices?.[0]?.message;
  const text = choice?.content || null;
  const toolCalls: ToolCall[] = (choice?.tool_calls || []).map(
    (tc: {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }),
  );

  return {
    text,
    toolCalls,
    usage: {
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    },
  };
}

// ── Mock LLM (simulated responses for testing without API key) ──

// 4 tools per turn × 6 turns = 24 tool calls (meets ≥20 requirement)
const MOCK_TOOL_SEQUENCE: string[][] = [
  // Turn 1: explore broadly
  ["grep", "read_file", "grep", "web_fetch"],
  // Turn 2: deep-dive into findings
  ["read_file", "grep", "read_file", "execute_command"],
  // Turn 3: fix core issues
  ["edit_file", "write_file", "grep", "read_file"],
  // Turn 4: fix remaining issues
  ["edit_file", "execute_command", "grep", "web_fetch"],
  // Turn 5: verify fixes
  ["execute_command", "grep", "read_file", "edit_file"],
  // Turn 6: final verification
  ["execute_command", "read_file", "grep", "web_fetch"],
];

function mockLLMResponse(
  turn: number,
  _messages: Message[],
  _config: AgentConfig,
): {
  text: string | null;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
} {
  // Always run 6 full turns before completing (meets ≥5 turn minimum)
  if (turn >= 6) {
    return {
      text: `Analysis complete. Found and fixed 3 bugs across 2 files. ` +
        `All tests pass. Summary: (1) fixed null-check in auth.ts, ` +
        `(2) added rate limiting to login.ts, (3) corrected edge case in utils.ts.`,
      toolCalls: [],
      usage: { input: 1245 + turn * 300, output: 85 },
    };
  }

  // Pick tool sequence for this turn
  const toolNames =
    MOCK_TOOL_SEQUENCE[turn % MOCK_TOOL_SEQUENCE.length] ||
    MOCK_TOOL_SEQUENCE[0];

  const toolCalls: ToolCall[] = toolNames.map((name, i) => ({
    id: `mock-${turn}-${i}`,
    type: "function" as const,
    function: {
      name,
      arguments: mockToolArgs(name),
    },
  }));

  return {
    text: null,
    toolCalls,
    usage: { input: 980 + turn * 250, output: toolCalls.length * 40 },
  };
}

function mockToolArgs(name: string): string {
  switch (name) {
    case "read_file":
      return JSON.stringify({ path: "src/auth.ts" });
    case "grep":
      return JSON.stringify({ pattern: "TODO|FIXME|bug" });
    case "write_file":
      return JSON.stringify({
        path: "test/auth.test.ts",
        content: "// generated test",
      });
    case "edit_file":
      return JSON.stringify({
        path: "src/auth.ts",
        old_string: "if (!input)",
        new_string: 'if (!input) throw new Error("empty input")',
      });
    case "execute_command":
      return JSON.stringify({ command: "npm test" });
    case "web_fetch":
      return JSON.stringify({ url: "https://docs.example.com/api" });
    default:
      return "{}";
  }
}
