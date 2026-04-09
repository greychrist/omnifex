import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '@/lib/api';
import type { ClaudeStreamMessage } from '../AgentExecution';

interface UseClaudeMessagesOptions {
  onSessionInfo?: (info: { sessionId: string; projectId: string }) => void;
  onTokenUpdate?: (tokens: number) => void;
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
}

export function useClaudeMessages(options: UseClaudeMessagesOptions = {}) {
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const [rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  
  const eventListenerRef = useRef<(() => void) | null>(null);
  const accumulatedContentRef = useRef<{ [key: string]: string }>({});

  const handleMessage = useCallback((message: ClaudeStreamMessage) => {
    console.log('[TRACE] useClaudeMessages.handleMessage called with:', message);
    
    if ((message as any).type === "start") {
      console.log('[TRACE] Start message detected - clearing accumulated content and setting streaming=true');
      // Clear accumulated content for new stream
      accumulatedContentRef.current = {};
      setIsStreaming(true);
      options.onStreamingChange?.(true, currentSessionId);
    } else if ((message as any).type === "partial") {
      console.log('[TRACE] Partial message detected');
      if (message.tool_calls && message.tool_calls.length > 0) {
        message.tool_calls.forEach((toolCall: any) => {
          if (toolCall.content && toolCall.partial_tool_call_index !== undefined) {
            const key = `tool-${toolCall.partial_tool_call_index}`;
            if (!accumulatedContentRef.current[key]) {
              accumulatedContentRef.current[key] = "";
            }
            accumulatedContentRef.current[key] += toolCall.content;
            toolCall.accumulated_content = accumulatedContentRef.current[key];
          }
        });
      }
    } else if ((message as any).type === "response" && message.message?.usage) {
      console.log('[TRACE] Response message with usage detected');
      const totalTokens = (message.message.usage.input_tokens || 0) + 
                         (message.message.usage.output_tokens || 0);
      console.log('[TRACE] Total tokens:', totalTokens);
      options.onTokenUpdate?.(totalTokens);
    } else if ((message as any).type === "error" || (message as any).type === "response") {
      console.log('[TRACE] Error or response message detected - setting streaming=false');
      setIsStreaming(false);
      options.onStreamingChange?.(false, currentSessionId);
    } else if ((message as any).type === "output") {
      console.log('[TRACE] Output message detected, content:', (message as any).content);
    } else {
      console.log('[TRACE] Unknown message type:', (message as any).type);
    }

    console.log('[TRACE] Adding message to state');
    setMessages(prev => {
      const newMessages = [...prev, message];
      console.log('[TRACE] Total messages now:', newMessages.length);
      return newMessages;
    });
    setRawJsonlOutput(prev => [...prev, JSON.stringify(message)]);

    // Extract session info
    if ((message as any).type === "session_info" && (message as any).session_id && (message as any).project_id) {
      console.log('[TRACE] Session info detected:', (message as any).session_id, (message as any).project_id);
      options.onSessionInfo?.({
        sessionId: (message as any).session_id,
        projectId: (message as any).project_id
      });
      setCurrentSessionId((message as any).session_id);
    }
  }, [currentSessionId, options]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setRawJsonlOutput([]);
    accumulatedContentRef.current = {};
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const output = await api.getSessionOutput(parseInt(sessionId));
      // Note: API returns a string, not an array of outputs
      const outputs = [{ jsonl: output }];
      const loadedMessages: ClaudeStreamMessage[] = [];
      const loadedRawJsonl: string[] = [];
      
      outputs.forEach(output => {
        if (output.jsonl) {
          const lines = output.jsonl.split('\n').filter(line => line.trim());
          lines.forEach(line => {
            try {
              const msg = JSON.parse(line);
              loadedMessages.push(msg);
              loadedRawJsonl.push(line);
            } catch (e) {
              console.error("Failed to parse JSONL:", e);
            }
          });
        }
      });
      
      setMessages(loadedMessages);
      setRawJsonlOutput(loadedRawJsonl);
    } catch (error) {
      console.error("Failed to load session outputs:", error);
      throw error;
    }
  }, []);

  // Set up event listener
  useEffect(() => {
    console.log('[TRACE] useClaudeMessages setupListener called');
    if (eventListenerRef.current) {
      console.log('[TRACE] Cleaning up existing event listener');
      eventListenerRef.current();
    }

    // Electron mode - use electronAPI IPC events
    console.log('[TRACE] Setting up Electron event listener for claude-stream');
    eventListenerRef.current = window.electronAPI.onEvent("claude-stream", (payload: any) => {
      console.log('[TRACE] Electron IPC event received:', payload);
      try {
        const message = JSON.parse(payload) as ClaudeStreamMessage;
        console.log('[TRACE] Parsed message:', message);
        handleMessage(message);
      } catch (error) {
        console.error("[TRACE] Failed to parse Claude stream message:", error);
      }
    });
    console.log('[TRACE] Electron event listener setup complete');

    return () => {
      console.log('[TRACE] useClaudeMessages cleanup');
      if (eventListenerRef.current) {
        eventListenerRef.current();
      }
    };
  }, [handleMessage]);

  return {
    messages,
    rawJsonlOutput,
    isStreaming,
    currentSessionId,
    clearMessages,
    loadMessages,
    handleMessage
  };
}