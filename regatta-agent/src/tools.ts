/**
 * Tool definitions matching Sail's agent tool set.
 * Execution is simulated — no real filesystem access in Wasm.
 * Realistic but fast results for benchmarking concurrency.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

// ── Tool definitions (same names and shapes as Sail) ──

export const TOOLS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Returns the file content as a string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search for a regex pattern in files under a directory. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Directory or file path to search in (default: cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it does not exist, overwrites if it does.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Apply a targeted edit to a file using exact string replacement. Replaces old_string with new_string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "execute_command",
    description:
      "Run a shell command and return stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch content from a URL and return the response body as plain text.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
];

// ── Simulated tool execution ──

/**
 * Execute a tool call and return a simulated result.
 * Each result is deterministic based on input — looks realistic
 * but requires no filesystem or network access.
 */
export function executeTool(tc: ToolCall): ToolResult {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || "{}");
  } catch {
    // LLM sometimes produces malformed JSON — use empty args as fallback
    args = { _raw: tc.function.arguments };
  }
  const content = simulateResult(tc.function.name, args);

  return {
    tool_call_id: tc.id,
    role: "tool",
    content,
  };
}

function simulateResult(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file": {
      const path = args.path || "unknown.ts";
      return [
        `// ${path}`,
        `import { something } from "./module";`,
        ``,
        `export function process(input: string): string {`,
        `  // TODO: fix validation logic here`,
        `  if (!input) throw new Error("empty input");`,
        `  return input.trim().toLowerCase();`,
        `}`,
        ``,
        `// 42 lines total — truncated for brevity`,
      ].join("\n");
    }

    case "grep": {
      const pattern = args.pattern || "TODO";
      const path = args.path || "src/";
      return [
        `Found 3 matches for "${pattern}" in ${String(path)}:`,
        `  src/auth.ts:15:  // TODO: validate token expiry`,
        `  src/login.ts:42: // TODO: add rate limiting`,
        `  src/utils.ts:8:  // TODO: handle edge case`,
      ].join("\n");
    }

    case "write_file": {
      const wrotePath = args.path || "output.txt";
      const content = String(args.content || "");
      return `Successfully wrote ${content.length} bytes to ${wrotePath}`;
    }

    case "edit_file": {
      const editPath = args.path || "src/file.ts";
      return [
        `Applied edit to ${editPath}:`,
        `  2 insertion(s)`,
        `  1 deletion(s)`,
        `  File now has 47 lines`,
      ].join("\n");
    }

    case "execute_command": {
      const cmd = String(args.command || "echo ok");
      return [
        `$ ${cmd}`,
        `[stdout]:`,
        `Command completed successfully.`,
        `[exit code: 0]`,
      ].join("\n");
    }

    case "web_fetch": {
      const url = String(args.url || "https://example.com");
      return [
        `HTTP 200 OK — ${url}`,
        `Content-Type: application/json`,
        ``,
        `{`,
        `  "status": "ok",`,
        `  "data": { "items": [1, 2, 3] }`,
        `}`,
      ].join("\n");
    }

    default:
      return `Tool "${name}" executed successfully (simulated).`;
  }
}
