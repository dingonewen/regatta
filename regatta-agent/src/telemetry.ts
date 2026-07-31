/**
 * Lightweight OpenTelemetry span tracking.
 *
 * Generates traceId/spanId/parentSpanId in standard OTel hex format.
 * Keeps spans in memory for the lifetime of one agent run.
 * Spin's built-in OTel runtime handles actual OTLP export —
 * this module enriches spans with application-level attributes
 * (tool names, turn numbers, LLM timing, etc.).
 */

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number>;
}

/**
 * Generate a random hex string (Math.random-based).
 * Spin's JS runtime does not expose crypto.getRandomValues, so we
 * use Math.random. Sufficient for trace/span IDs in a benchmark POC.
 */
function randomHex(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 16).toString(16);
  }
  return result;
}

/** 32-char hex trace ID, matching W3C trace-id format */
export function generateTraceId(): string {
  return randomHex(32);
}

/** 16-char hex span ID */
export function generateSpanId(): string {
  return randomHex(16);
}

/** Convert high-res timestamp to nanoseconds (OTel convention) */
function nowNs(): number {
  return Math.round(performance.now() * 1_000_000);
}

export class Telemetry {
  private spans: Span[] = [];
  readonly traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId || generateTraceId();
  }

  /** Start a span, return its spanId */
  startSpan(
    name: string,
    parentSpanId?: string,
    attrs?: Record<string, string | number>,
  ): string {
    const spanId = generateSpanId();
    const span: Span = {
      name,
      traceId: this.traceId,
      spanId,
      parentSpanId,
      startTime: nowNs(),
      endTime: 0,
      attributes: attrs ? { ...attrs } : {},
    };
    this.spans.push(span);
    return spanId;
  }

  /** End a span, optionally adding final attributes */
  endSpan(spanId: string, attrs?: Record<string, string | number>): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.endTime = nowNs();
    if (attrs) {
      Object.assign(span.attributes, attrs);
    }
  }

  /** Mark a span as failed with an error attribute */
  failSpan(spanId: string, error: string): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.endTime = nowNs();
    span.attributes["error"] = error;
    span.attributes["status"] = "error";
  }

  /** Get all collected spans (for serialization in the HTTP response) */
  getSpans(): Span[] {
    return [...this.spans];
  }

  /** Human-readable summary */
  summary(): string {
    const completed = this.spans.filter((s) => s.endTime > 0);
    const durations = completed.map(
      (s) => (s.endTime - s.startTime) / 1_000_000,
    ); // ms
    return [
      `traceId: ${this.traceId}`,
      `spans: ${this.spans.length} total, ${completed.length} completed`,
      durations.length
        ? `durations: ${Math.min(...durations).toFixed(0)}–${Math.max(...durations).toFixed(0)} ms`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }
}
