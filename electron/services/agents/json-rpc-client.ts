export interface JsonRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respondToServer(
    id: string | number,
    payload: { result: unknown } | { error: { code: number; message: string } },
  ): void;
  close(): void;
}

export interface JsonRpcClientOptions {
  readable: NodeJS.ReadableStream;
  writable: NodeJS.WritableStream;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown, id: string | number) => void;
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type InboundFrame = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export function createJsonRpcClient(opts: JsonRpcClientOptions): JsonRpcClient {
  const { readable, writable, onNotification, onServerRequest } = opts;

  const pendingByClientId = new Map<number, PendingEntry>();
  let nextClientId = 1;
  let lineBuf = '';
  let closed = false;

  function handleLine(line: string): void {
    if (line.length === 0) return;

    let frame: InboundFrame;
    try {
      frame = JSON.parse(line) as InboundFrame;
    } catch {
      return;
    }

    const id = frame.id;
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error');

    if (typeof id === 'number' && (hasResult || hasError)) {
      const pending = pendingByClientId.get(id);
      if (!pending) return;
      pendingByClientId.delete(id);
      if (hasError) {
        const err = frame.error as { code?: unknown; message?: unknown } | undefined;
        const msg = typeof err?.message === 'string' ? err.message : 'JSON-RPC error';
        const code = typeof err?.code === 'number' ? err.code : undefined;
        const text = code !== undefined ? `${msg} (code ${code})` : msg;
        pending.reject(new Error(text));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (typeof frame.method === 'string' && (typeof id === 'string' || typeof id === 'number')) {
      if (onServerRequest) {
        try {
          onServerRequest(frame.method, frame.params, id);
        } catch {
          /* subscriber threw — swallow so one bad handler can't poison the receive loop */
        }
      }
      return;
    }

    if (typeof frame.method === 'string' && id === undefined) {
      if (onNotification) {
        try {
          onNotification(frame.method, frame.params);
        } catch {
          /* subscriber threw */
        }
      }
      return;
    }
  }

  readable.on('data', (chunk: Buffer | string) => {
    lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = lineBuf.indexOf('\n');
    while (nl !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
      nl = lineBuf.indexOf('\n');
    }
  });

  function writeFrame(obj: unknown): void {
    writable.write(JSON.stringify(obj) + '\n');
  }

  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (closed) return Promise.reject(new Error('JSON-RPC client closed'));
    const id = nextClientId++;
    return new Promise<T>((resolve, reject) => {
      pendingByClientId.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      const frame =
        params === undefined
          ? { jsonrpc: '2.0', id, method }
          : { jsonrpc: '2.0', id, method, params };
      writeFrame(frame);
    });
  }

  function respondToServer(
    id: string | number,
    payload: { result: unknown } | { error: { code: number; message: string } },
  ): void {
    writeFrame({ jsonrpc: '2.0', id, ...payload });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    const err = new Error('JSON-RPC client closed');
    for (const pending of pendingByClientId.values()) {
      try {
        pending.reject(err);
      } catch {
        /* swallow */
      }
    }
    pendingByClientId.clear();
  }

  return { request, respondToServer, close };
}
