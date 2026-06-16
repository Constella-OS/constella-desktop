/**
 * Minimal Streamable-HTTP MCP server (main process).
 *
 * Implements the slice both `claude --print` and `codex exec` need to connect:
 *   - POST /mcp accepts a single JSON-RPC 2.0 message or a batch
 *   - Returns application/json for request responses, 202 for notifications
 *   - Methods: initialize, notifications/initialized, ping, tools/list, tools/call
 *   - Bearer auth on every POST (the only thing protecting localhost from
 *     other users / unrelated processes on the same machine)
 *
 * Hand-rolled instead of pulling @modelcontextprotocol/sdk because the SDK is
 * ESM-only and would fight our transpile-only webpack build. The wire protocol
 * is tiny — only what's documented here is supported.
 *
 * Ported from agents-slack src/main/mcp/server.ts. Constella additions:
 *   - SERVER_INFO renamed to "constella"
 *   - the returned handle exposes `listening()` so the lifecycle watchdog can
 *     cheaply check liveness before falling back to a real self-ping.
 */
import http from 'http';
import { randomUUID } from 'crypto';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServerHandle {
  url: string;
  port: number;
  /** True while the underlying http server is actively bound + listening. */
  listening: () => boolean;
  close: () => Promise<void>;
}

export interface CreateOptions {
  tools: McpTool[];
  secret: string;
  /** Logger for unexpected handler errors. Defaults to no-op. */
  onError?: (err: unknown, ctx: { method: string; tool?: string }) => void;
  /** Logger for call start/end. Lets us trace slow tools without bloating
   *  the dispatcher itself. Defaults to no-op. */
  onCall?: (ctx: { tool: string; durationMs: number; ok: boolean; reason?: string }) => void;
  /** Fired if the http server emits 'error' or 'close' AFTER it was listening
   *  (i.e. an unexpected death). The lifecycle supervisor uses this to restart. */
  onUnexpectedClose?: (reason: string) => void;
  /** Per-tool-call hard timeout. The CLI's own MCP client timeout is ~60s; we
   *  fail faster so parallel calls behind us on the same keep-alive socket can
   *  proceed instead of head-of-lining. */
  toolTimeoutMs?: number;
  /**
   * Browser Origins allowed to call /mcp WITHOUT the bearer token (the Chrome
   * extension — web pages cannot spoof the Origin header). Exact origins like
   * "chrome-extension://<id>", or the wildcard "chrome-extension://*" to allow
   * any extension. A request that carries an Origin NOT in this list is
   * rejected even with a valid bearer: no browser caller should hold the token.
   */
  allowedOrigins?: string[];
  /** Extra fields merged into the unauthenticated GET /health response
   *  (used by the extension's port probe: {port, ready, ...}). */
  getHealth?: () => Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'constella', version: '0.1.0' };

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: any;
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}
function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function dispatch(
  msg: JsonRpcRequest,
  toolMap: Map<string, McpTool>,
  onError: NonNullable<CreateOptions['onError']>,
  onCall: NonNullable<CreateOptions['onCall']>,
  toolTimeoutMs: number,
): Promise<unknown | null> {
  // Notifications have no id and never get a response.
  const isNotification = msg.id === undefined;
  const id: JsonRpcId = isNotification ? null : (msg.id as JsonRpcId);

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'invalid request');
  }

  switch (msg.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: Array.from(toolMap.values()).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = typeof name === 'string' ? toolMap.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      const startedAt = Date.now();
      try {
        const out = await withTimeout(tool.handler(args), toolTimeoutMs, `tool ${name}`);
        // MCP tools always return a `content` array. Wrap raw values as text.
        const content =
          out && typeof out === 'object' && Array.isArray((out as any).content)
            ? (out as any).content
            : [
                {
                  type: 'text',
                  text: typeof out === 'string' ? out : JSON.stringify(out, null, 2),
                },
              ];
        onCall({ tool: name, durationMs: Date.now() - startedAt, ok: true });
        return rpcResult(id, { content, isError: false });
      } catch (err: any) {
        const reason = err?.message || String(err);
        onError(err, { method: msg.method, tool: name });
        onCall({ tool: name, durationMs: Date.now() - startedAt, ok: false, reason });
        return rpcResult(id, {
          content: [{ type: 'text', text: `error: ${reason}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

// 50 MB: large enough for a base64-encoded PDF (~48 MB base64 ≈ 36 MB binary)
// sent by the Chrome extension's local-first `create_pdf` capture. Loopback
// transfer is effectively free, but readBody buffers + stringifies + JSON.parses
// the whole body, so peak transient memory is ~2-3x the payload — hence a cap
// rather than no limit. Oversized bodies still reject cleanly with 413.
function readBody(req: http.IncomingMessage, limitBytes = 50 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function originAllowed(origin: string, allowed: string[]): boolean {
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (entry.endsWith('://*') && origin.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

export function createMcpHttpServer(opts: CreateOptions): {
  listen: (port?: number, host?: string) => Promise<McpServerHandle>;
} {
  const toolMap = new Map<string, McpTool>();
  for (const t of opts.tools) toolMap.set(t.name, t);
  const onError = opts.onError ?? (() => undefined);
  const onCall = opts.onCall ?? (() => undefined);
  // 25s default — comfortably under the CLI's ~60s MCP client timeout so the
  // failure surfaces on our side first (and unblocks parallel calls queued
  // behind us on the same keep-alive socket).
  const toolTimeoutMs = opts.toolTimeoutMs ?? 25_000;
  const allowedOrigins = opts.allowedOrigins ?? [];

  // Set once listen() succeeds; the Host check needs the real bound port.
  let boundPort: number | null = null;

  // DNS-rebinding defense: a malicious page can point its own domain at
  // 127.0.0.1 and make same-origin requests to us — but those arrive with
  // `Host: evil.com`. Only serve requests addressed to localhost:ourPort.
  const isAllowedHost = (hostHeader: unknown): boolean => {
    if (typeof hostHeader !== 'string' || !hostHeader) return false;
    const [hostname, portStr] = hostHeader.split(':');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
    if (boundPort === null) return true; // pre-bind (never happens in practice)
    return Number(portStr) === boundPort;
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '').split('?')[0];

    if (!isAllowedHost(req.headers.host)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }

    // Unauthenticated identity probe — the Chrome extension scans the fixed
    // port range and matches on `app` to find us. No user data exposed.
    if (req.method === 'GET' && urlPath === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          app: SERVER_INFO.name,
          version: SERVER_INFO.version,
          ...(opts.getHealth?.() ?? {}),
        }),
      );
      return;
    }

    if (req.method !== 'POST' || urlPath !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }

    // JSON only. Also blocks preflight-dodging cross-origin POSTs: a web page
    // can fire a no-preflight text/plain POST at localhost, but not an
    // application/json one.
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      res.statusCode = 415;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'content-type must be application/json' }));
      return;
    }

    // Credential: an allowlisted browser Origin (Chrome extension — browsers
    // set Origin, pages can't spoof it) OR the bearer token (CLI agents send
    // no Origin). A present-but-unknown Origin fails even with a valid
    // bearer; no browser caller should ever hold the token.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const bearerOk = req.headers['authorization'] === `Bearer ${opts.secret}`;
    const authorized = origin !== null ? originAllowed(origin, allowedOrigins) : bearerOk;
    if (!authorized) {
      res.statusCode = origin !== null ? 403 : 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (e: any) {
      res.statusCode = 413;
      res.end(JSON.stringify({ error: e?.message || 'read failed' }));
      return;
    }

    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(rpcError(null, -32700, 'parse error')));
      return;
    }

    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    const responses: unknown[] = [];
    for (const m of msgs) {
      const out = await dispatch(m, toolMap, onError, onCall, toolTimeoutMs);
      if (out !== null) responses.push(out);
    }

    // All-notifications batch → 202 Accepted, no body.
    if (responses.length === 0) {
      res.statusCode = 202;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Mcp-Session-Id', randomUUID());
    res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  });

  // Node's 5s default keepAliveTimeout races client agents that reuse idle
  // sockets (first request after idle gets ECONNRESET). 30s shrinks that
  // window; clients still retry once on connection failure.
  server.keepAliveTimeout = 30_000;

  return {
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        let didListen = false;
        // Before we're listening, a bind error rejects the listen() promise.
        // After we're listening, an 'error'/'close' is an unexpected death the
        // supervisor must heal — route it to onUnexpectedClose instead.
        const onPreListenError = (err: Error) => reject(err);
        server.once('error', onPreListenError);
        server.listen(port, host, () => {
          didListen = true;
          server.removeListener('error', onPreListenError);
          server.on('error', (err) => {
            opts.onUnexpectedClose?.(err?.message || 'server error');
          });
          server.on('close', () => {
            if (didListen) opts.onUnexpectedClose?.('server closed');
          });
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            reject(new Error('failed to bind MCP server'));
            return;
          }
          boundPort = addr.port;
          resolve({
            url: `http://${host}:${addr.port}/mcp`,
            port: addr.port,
            listening: () => server.listening,
            close: () =>
              new Promise<void>((res2) => {
                // Mark intentional close so the 'close' handler stays quiet.
                didListen = false;
                server.close(() => res2());
              }),
          });
        });
      }),
  };
}
