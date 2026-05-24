// Auto-generated fixtures sampled from real session JSONL files.
// One representative line per (type/subtype) combination.
// DO NOT manually edit — re-run the extraction script in Task 2 to refresh.
// Sensitive content stripped from text blocks; structural fields preserved.

export const JSONL_SAMPLES = {
  'ai-title': {
  "type": "ai-title",
  "aiTitle": "Examine code directory structure",
  "sessionId": "0e1e60a9-7c56-4a8e-a185-3083ec130353"
} as const,
  'assistant': {
  "parentUuid": "0cdeeaba-3a55-413c-b769-6df3e80ae5e4",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_01MJMFCFAs4DRmuRRrscuP6L",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "",
        "signature": "REDACTED"
      }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "stop_details": null,
    "usage": {
      "input_tokens": 6,
      "cache_creation_input_tokens": 26269,
      "cache_read_input_tokens": 18974,
      "output_tokens": 336,
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 26269,
        "ephemeral_5m_input_tokens": 0
      },
      "inference_geo": "",
      "iterations": [
        {
          "input_tokens": 6,
          "output_tokens": 336,
          "cache_read_input_tokens": 18974,
          "cache_creation_input_tokens": 26269,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 26269
          },
          "type": "message"
        }
      ],
      "speed": "standard"
    },
    "diagnostics": null
  },
  "requestId": "req_011Cb3y138m64sYkb6nMA6QZ",
  "type": "assistant",
  "uuid": "74ba9e3d-31ed-4c5c-a310-9c76b984af60",
  "timestamp": "2026-05-15T07:33:15.033Z",
  "userType": "external",
  "entrypoint": "sdk-ts",
  "cwd": "/Users/test/proj",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51",
  "version": "2.1.142",
  "gitBranch": "main"
} as const,
  'attachment': {
  "parentUuid": null,
  "isSidechain": false,
  "attachment": {
    "type": "hook_success",
    "hookName": "SessionStart:startup",
    "toolUseID": "91c6b9d9-1bbe-4fb5-850d-813d310ee3a0",
    "hookEvent": "SessionStart",
    "content": "",
    "stdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"...\"}}",
    "stderr": "",
    "exitCode": 0,
    "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
    "durationMs": 370
  },
  "type": "attachment",
  "uuid": "974658d6-b8fc-4b99-886d-e970da950bac",
  "timestamp": "2026-05-15T07:32:27.846Z",
  "userType": "external",
  "entrypoint": "sdk-ts",
  "cwd": "/Users/test/proj",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51",
  "version": "2.1.142",
  "gitBranch": "main"
} as const,
  'file-history-snapshot': {
  "type": "file-history-snapshot",
  "messageId": "b3915b12-ab37-4763-b702-4b47b1313988",
  "snapshot": {
    "messageId": "b3915b12-ab37-4763-b702-4b47b1313988",
    "trackedFileBackups": {},
    "timestamp": "2026-04-27T15:34:54.293Z"
  },
  "isSnapshotUpdate": false
} as const,
  'last-prompt': {
  "type": "last-prompt",
  "lastPrompt": "...",
  "leafUuid": "0cdeeaba-3a55-413c-b769-6df3e80ae5e4",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51"
} as const,
  'permission-mode': {
  "type": "permission-mode",
  "permissionMode": "acceptEdits",
  "sessionId": "04f76fd3-fee7-4588-916d-92aab131fcc7"
} as const,
  'queue-operation': {
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-05-15T07:33:08.502Z",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51",
  "content": "..."
} as const,
  'system/api_error': {
  "parentUuid": "a1cd9ba8-6487-4893-a79f-c8d84de98ba6",
  "isSidechain": false,
  "type": "system",
  "subtype": "api_error",
  "level": "error",
  "error": {
    "type": null
  },
  "retryInMs": 514.736592462179,
  "retryAttempt": 1,
  "maxRetries": 10,
  "timestamp": "2026-05-05T00:23:00.540Z",
  "uuid": "9513fc39-8790-4522-928d-7a6f26e04060",
  "userType": "external",
  "entrypoint": "sdk-ts",
  "cwd": "/Users/test/proj",
  "sessionId": "353f1e69-1fc1-452b-bc78-8abbefe2f7ce",
  "version": "2.1.128",
  "gitBranch": "main"
} as const,
  'system/away_summary': {
  "parentUuid": "059078bb-6a15-4b4e-801b-d9bdba9b8f47",
  "isSidechain": false,
  "type": "system",
  "subtype": "away_summary",
  "content": "...",
  "timestamp": "2026-04-29T17:22:21.793Z",
  "uuid": "89a4c485-5052-4fa8-ae45-c7798caf9b16",
  "isMeta": false,
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/Users/test/proj",
  "sessionId": "0e1e60a9-7c56-4a8e-a185-3083ec130353",
  "version": "2.1.123",
  "gitBranch": "main"
} as const,
  'system/local_command': {
  "parentUuid": "c8064e73-5bbc-41c2-a332-065e8647fa67",
  "isSidechain": false,
  "type": "system",
  "subtype": "local_command",
  "content": "<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>",
  "level": "info",
  "timestamp": "2026-04-27T15:34:51.333Z",
  "uuid": "764cc1fe-4811-46d2-a18b-e1f5e2780c31",
  "isMeta": false,
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/Users/test/proj",
  "sessionId": "04f76fd3-fee7-4588-916d-92aab131fcc7",
  "version": "2.1.119",
  "gitBranch": "main"
} as const,
  'system/stop_hook_summary': {
  "parentUuid": "e1d44641-7100-4fdd-8408-bdef7f745da7",
  "isSidechain": false,
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 3,
  "hookInfos": [
    {
      "command": "/Users/test/.claude-personal/hooks/check-unfinished-todos.py",
      "durationMs": 40
    },
    {
      "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-unfinished-todos.py",
      "durationMs": 41
    },
    {
      "command": "callback"
    }
  ],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": false,
  "level": "suggestion",
  "timestamp": "2026-05-15T07:33:53.384Z",
  "uuid": "85f2dcc5-c9c9-4dc7-bbef-326c01d7fe9a",
  "toolUseID": "2980c373-39aa-463d-8998-38c77444756f",
  "userType": "external",
  "entrypoint": "sdk-ts",
  "cwd": "/Users/test/proj",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51",
  "version": "2.1.142",
  "gitBranch": "main"
} as const,
  'system/turn_duration': {
  "parentUuid": "aea964c6-694f-4581-9809-6e0fa21e7113",
  "isSidechain": false,
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 25695,
  "messageCount": 12,
  "timestamp": "2026-04-29T17:19:18.835Z",
  "uuid": "059078bb-6a15-4b4e-801b-d9bdba9b8f47",
  "isMeta": false,
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/Users/test/proj",
  "sessionId": "0e1e60a9-7c56-4a8e-a185-3083ec130353",
  "version": "2.1.123",
  "gitBranch": "main"
} as const,
  'user': {
  "parentUuid": "358af6ec-8895-4ad5-857e-0b0880ef6295",
  "isSidechain": false,
  "promptId": "8c6cc18a-9090-4102-b741-13bb7a848fc7",
  "type": "user",
  "message": {
    "role": "user",
    "content": "..."
  },
  "uuid": "eac08789-8060-486b-8f6e-90843e345301",
  "timestamp": "2026-05-15T07:33:08.506Z",
  "permissionMode": "auto",
  "userType": "external",
  "entrypoint": "sdk-ts",
  "cwd": "/Users/test/proj",
  "sessionId": "00593888-436b-4a2d-9760-729119d27b51",
  "version": "2.1.142",
  "gitBranch": "main"
} as const,
} as const;
