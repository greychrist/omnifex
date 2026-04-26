/**
 * Shape of one message off the Claude Agent SDK stream, as we receive it
 * in the renderer. Mirrors what `claude-output:<tabId>` events deliver.
 *
 * The SDK exposes a more strictly-typed union, but our renderer treats
 * messages permissively (via the index signature) so it can carry tool-
 * specific fields, error details, and our own augmentations like
 * `receivedAt`.
 */
export interface ClaudeStreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'permission_request';
  subtype?: string;
  request_id?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  message?: {
    content?: any[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /** ISO timestamp stamped by the main process as the message was received
   *  from the SDK stream. Absent on messages loaded from a session's JSONL
   *  (the SDK's history has no per-message timestamp). */
  receivedAt?: string;
  [key: string]: any;
}
