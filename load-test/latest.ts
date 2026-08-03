/**
 * Show cold-start breakdown for the latest results file.
 * Usage: npm run latest
 */

import { readdirSync, readFileSync } from "node:fs";

const files = readdirSync(".")
  .filter((f) => f.startsWith("results-"))
  .sort();
const latest = files.pop();

if (!latest) {
  console.log("No results files found.");
  process.exit(1);
}

const raw = readFileSync(latest, "utf-8");
const data = JSON.parse(raw);
const agents = data.runs[0].agents as Array<{
  agentId: string;
  startedAt: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  passed: boolean;
}>;

const base = agents[0].startedAt;

console.log(`\nFile: ${latest}\n`);
for (const a of agents) {
  const cold = a.startedAt - base;
  console.log(
    `${a.agentId}  cold=${cold}ms  turns=${a.turns}  tools=${a.toolCalls}  dur=${a.durationMs}ms  ${a.passed ? "✓" : "✗"}`,
  );
}
