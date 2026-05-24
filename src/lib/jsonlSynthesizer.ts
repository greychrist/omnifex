import type { JsonlNode, UsageShape } from '@/types/jsonl';

/**
 * Stop reasons that terminate a turn. An assistant message carrying one of
 * these is "the end of the user's exchange" — even if not a clean
 * completion. Synthesizer emits a result card after each.
 *
 * `tool_use` is an interstitial step (turn continues with tool_result).
 * Missing/null stop_reason means the assistant message is partial.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
]);

// Token cost rates used for session cost estimation.
const INPUT_RATE_PER_TOKEN = 0.000003;
const OUTPUT_RATE_PER_TOKEN = 0.000015;

export interface Synthesizer {
  /** Feed one classified node in; returns input + any synthesized output. */
  push(node: JsonlNode): JsonlNode[];
  /** Flush at end-of-stream; emits synth-result for an unterminated turn. */
  flush(): JsonlNode[];
}

/**
 * Construct a streaming synthesizer. Stateful — tracks turn boundaries,
 * pending assistant messages, and whether `synth-init` has already fired.
 */
export function createSynthesizer(): Synthesizer {
  let initFired = false;
  let turnStartAt: string | null = null;
  let pendingAssistant: Extract<JsonlNode, { kind: 'assistant' }> | null = null;
  // synthCandidate: assistant with terminal stop waiting to see if a real result
  // arrives next. If it does, the synth is cancelled. If anything else arrives
  // (or flush is called), the synth is emitted first.
  let synthCandidate: Extract<JsonlNode, { kind: 'assistant' }> | null = null;

  const out: JsonlNode[] = [];

  function maybeEmitInit(sessionId: string, cwd: string, receivedAt: string): void {
    if (initFired) return;
    if (!sessionId) return;
    initFired = true;
    out.push({
      kind: 'synthesized-init',
      sessionId,
      cwd,
      receivedAt,
    });
  }

  function emitResult(assistant: Extract<JsonlNode, { kind: 'assistant' }>): void {
    const stop = assistant.raw.message.stop_reason ?? null;
    const isTerminalClean = typeof stop === 'string' && SUCCESS_STOP_REASONS.has(stop);
    const startMs = turnStartAt ? Date.parse(turnStartAt) : NaN;
    const endMs = Date.parse(assistant.receivedAt);
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    const usage = (assistant.raw.message.usage ?? {}) as UsageShape;
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    const totalCostUsd = inputTokens * INPUT_RATE_PER_TOKEN + outputTokens * OUTPUT_RATE_PER_TOKEN;
    const lastText = extractLastText(assistant.raw.message.content);

    out.push({
      kind: 'synthesized-result',
      sessionId: assistant.sessionId,
      isError: !isTerminalClean,
      subtype: isTerminalClean ? 'success' : 'error_during_execution',
      body: lastText,
      durationMs,
      usage,
      totalCostUsd,
      stopReason: stop,
      receivedAt: assistant.receivedAt,
    });
  }

  /** Emit the deferred synth-result if one is waiting and nothing cancelled it. */
  function maybeFlushSynth(): void {
    if (!synthCandidate) return;
    emitResult(synthCandidate);
    synthCandidate = null;
  }

  function flushPending(): void {
    if (!pendingAssistant) return;
    // Unterminated turn — emit an error result.
    emitResult({
      ...pendingAssistant,
      raw: {
        ...pendingAssistant.raw,
        message: {
          ...pendingAssistant.raw.message,
          stop_reason: null, // explicitly mark as unterminated
        },
      },
    });
    pendingAssistant = null;
  }

  return {
    push(node: JsonlNode): JsonlNode[] {
      out.length = 0;

      // Emit init on the first node carrying a sessionId.
      if ('sessionId' in node && node.sessionId) {
        const cwd = extractCwd(node);
        const receivedAt = 'receivedAt' in node && node.receivedAt ? node.receivedAt : new Date().toISOString();
        maybeEmitInit(node.sessionId, cwd, receivedAt);
      }

      // Real result from the SDK iterator — cancel any pending synth (real wins).
      if (node.kind === 'real-result') {
        synthCandidate = null;
        out.push(node);
        return [...out];
      }

      if (node.kind === 'user' && node.userKind === 'prompt') {
        // New turn boundary. Flush any deferred synth from the previous turn,
        // then flush any pending unterminated assistant.
        maybeFlushSynth();
        flushPending();
        turnStartAt = node.receivedAt;
        out.push(node);
        return [...out];
      }

      if (node.kind === 'assistant') {
        const stop = node.raw.message.stop_reason ?? null;
        // Any non-result event arriving after a deferred synth means the real
        // result didn't come — flush the synth now.
        maybeFlushSynth();
        out.push(node);
        if (typeof stop === 'string' && TERMINAL_STOP_REASONS.has(stop)) {
          // Terminal turn-ender — defer synth emit to see if real result follows.
          pendingAssistant = null;
          synthCandidate = node;
        } else {
          // Mid-turn (tool_use) or partial (null) — hold for potential flush.
          pendingAssistant = node;
        }
        return [...out];
      }

      // Any other node: flush deferred synth first (real result didn't arrive).
      maybeFlushSynth();
      out.push(node);
      return [...out];
    },

    flush(): JsonlNode[] {
      out.length = 0;
      // Emit deferred synth before checking for an unterminated turn.
      maybeFlushSynth();
      flushPending();
      return [...out];
    },
  };
}

function extractCwd(node: JsonlNode): string {
  if (node.kind === 'assistant' || node.kind === 'user' || node.kind === 'attachment' || node.kind === 'system') {
    return (node.raw as { cwd?: string }).cwd ?? '';
  }
  return '';
}

function extractLastText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
}

/**
 * Batch wrapper — feeds an array of classified nodes through the streaming
 * synthesizer and returns the augmented sequence. Used by loadSessionHistory.
 */
export function synthesizeBatch(nodes: JsonlNode[]): JsonlNode[] {
  const s = createSynthesizer();
  const out: JsonlNode[] = [];
  for (const node of nodes) {
    out.push(...s.push(node));
  }
  out.push(...s.flush());
  return out;
}
