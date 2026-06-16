/**
 * App-wide MCP server lifecycle + auto-heal supervisor (main process).
 *
 * One HTTP server bound to 127.0.0.1 on the first free port in the fixed
 * 17865–17875 range (ephemeral only if ALL are taken), started at app boot
 * and torn down on quit. Clients:
 *   - Claude via inline `--mcp-config <json>` (see agentRunner.buildClaudeArgs)
 *   - Codex via a CODEX_HOME directory we own + write a config.toml into (so we
 *     don't clobber the user's global Codex config).
 *   - The Chrome extension, which self-discovers us by probing GET /health
 *     across the range and authenticates by Origin allowlist (no token) —
 *     see server.ts.
 *
 * Auto-heal: a watchdog self-pings the server every WATCHDOG_MS and restarts
 * after two consecutive failures (or instantly when the server isn't
 * listening / died unexpectedly via onUnexpectedClose); a powerMonitor resume
 * hook probes immediately after sleep. Restarts prefer the SAME port so the
 * already-written codex config.toml / claude config and the extension's
 * cached port stay valid; otherwise they re-scan the range. Ported from
 * agents-slack src/main/mcp/index.ts; watchdog/restart is the Constella
 * addition.
 */
import { app, powerMonitor } from 'electron';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

import { createMcpHttpServer, type McpServerHandle } from './server';
import { buildAppMcpTools } from './tools';
import { isLocalSearchReady } from './local-search';

const SERVER_NAME = 'constella';
/** Env var codex reads the MCP bearer token from. Codex 0.134's HTTP transport
 *  authenticates via `bearer_token_env_var` (a literal `[headers]` table reads
 *  back as "Auth: Unsupported"), so we hand the secret to codex through this
 *  env var, set in agentRunner.buildChildEnv. */
export const CODEX_MCP_TOKEN_ENV = 'CONSTELLA_MCP_TOKEN';
const WATCHDOG_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;
const MAX_PING_FAILS = 2;

/**
 * Fixed, well-known port range the Chrome extension probes (GET /health on
 * each until it finds `app: "constella"`). We bind the first free port in the
 * range; only if ALL are taken do we fall back to an ephemeral port (CLI
 * agents still work via the rewritten configs — the extension just won't find
 * us until a restart frees a range port).
 *
 * 17865–17875 deliberately avoids the crowded mnemonic ports: 8765 is
 * AnkiConnect's default (huge install base — guaranteed field collisions),
 * 6463–6472 is Discord RPC, 4370–4380 Spotify's web helper. This block is
 * unregistered with IANA and below the OS ephemeral range (49152+), so we
 * never race transient outbound sockets for it.
 */
const EXTENSION_PORT_RANGE_START = 17865;
const EXTENSION_PORT_RANGE_END = 17875;

/**
 * Browser Origins allowed to call /mcp without the bearer token.
 *
 * Pinned to the Constella extension's EXACT id — the extension manifest
 * carries a fixed `key`, so this id is identical on every install (dev
 * unpacked included). A wildcard here would let ANY installed extension read
 * local notes (any extension with host permissions can fetch 127.0.0.1 and
 * presents its own valid chrome-extension:// Origin). Web pages can never
 * forge a chrome-extension:// Origin at all.
 *
 * CONSTELLA_EXTENSION_ORIGINS (comma-separated) extends/overrides — needed
 * if the Chrome Web Store ever assigns a different production id.
 */
const CONSTELLA_EXTENSION_ID = 'mcafaiofkeamgppkdncicioamomdkfpg';

function extensionAllowedOrigins(): string[] {
  const extra = (process.env.CONSTELLA_EXTENSION_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [`chrome-extension://${CONSTELLA_EXTENSION_ID}`, ...extra];
}

export interface McpConnectionInfo {
  url: string;
  port: number;
  secret: string;
  /** Directory to use as CODEX_HOME when spawning codex. */
  codexHome: string;
  /** Inline value for `claude --mcp-config <json>`. */
  claudeMcpConfig: string;
}

let handle: McpServerHandle | null = null;
let info: McpConnectionInfo | null = null;
let secret: string | null = null;
let watchdog: NodeJS.Timeout | null = null;
let pingFails = 0;
let restarting = false;
let stopped = false;

function codexHomeDir(): string {
  return path.join(app.getPath('userData'), 'codex');
}

function writeCodexConfig(url: string): string {
  const dir = codexHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  // Canonical codex streamable-HTTP MCP entry (matches `codex mcp add --url …
  // --bearer-token-env-var …`). The bearer token itself is passed to codex via
  // the CODEX_MCP_TOKEN_ENV env var at spawn time (see agentRunner), not stored
  // on disk. We append the user's OWN configured codex MCP servers so in-app
  // agents can call them too (codex only reads MCP config from CODEX_HOME, which
  // we own — without this their `codex mcp add` servers are invisible in-app).
  const toml =
    [
      `[mcp_servers.${SERVER_NAME}]`,
      `url = "${url}"`,
      `bearer_token_env_var = "${CODEX_MCP_TOKEN_ENV}"`,
      '',
    ].join('\n') + readUserCodexMcpServers();
  fs.writeFileSync(path.join(dir, 'config.toml'), toml, 'utf8');
  syncCodexAuth(dir);
  return dir;
}

/**
 * Pull the user's own configured codex MCP servers out of ~/.codex/config.toml
 * so in-app agents can reach them. Copies through every `[mcp_servers.<name>]`
 * table (and its nested sub-tables) EXCEPT one named the same as ours, which our
 * block (written first) owns. Line-based on purpose — no TOML dep, and an mcp
 * table runs until the next top-level `[header]`. Returns '' on any error, so a
 * missing/garbled user config never blocks the in-app server.
 */
function readUserCodexMcpServers(): string {
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.codex', 'config.toml'),
      'utf8',
    );
    const out: string[] = [];
    let keep = false;
    for (const line of raw.split('\n')) {
      // A new table header resets whether we're copying. Keep it only when it's
      // an mcp_servers table for a server other than our own constella entry.
      if (/^\s*\[\[?/.test(line)) {
        const m = line.match(/^\s*\[\[?\s*mcp_servers(?:\.([^.\]\s]+))?/);
        keep = !!m && m[1]?.replace(/['"]/g, '') !== SERVER_NAME;
      }
      if (keep) out.push(line);
    }
    const text = out.join('\n').trim();
    return text ? `\n${text}\n` : '';
  } catch {
    return '';
  }
}

/**
 * Codex reads `auth.json` ONLY from $CODEX_HOME (no fallback to ~/.codex), so a
 * user who ran `codex login` (which writes ~/.codex/auth.json) would get a 401
 * in-app because our per-app CODEX_HOME has the MCP config.toml but no auth.
 * Sync their login into our CODEX_HOME. Copy-if-newer so we never clobber a
 * fresher token codex refreshed in-session. Best-effort: if there's no login,
 * codex can still auth via an inherited OPENAI_API_KEY env var.
 */
function syncCodexAuth(dir: string): void {
  try {
    const userAuth = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(userAuth)) return;
    const appAuth = path.join(dir, 'auth.json');
    const srcM = fs.statSync(userAuth).mtimeMs;
    const dstM = fs.existsSync(appAuth) ? fs.statSync(appAuth).mtimeMs : -1;
    if (srcM >= dstM) fs.copyFileSync(userAuth, appAuth);
  } catch {
    /* best-effort — codex falls back to OPENAI_API_KEY if present */
  }
}

function buildClaudeMcpConfig(url: string, sec: string): string {
  return JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${sec}` },
      },
    },
  });
}

/**
 * Where we persist the bearer secret + last bound port so they survive an app
 * RESTART (not just an in-session watchdog restart). Without this, the secret
 * is regenerated every launch and the port can drift — which silently breaks
 * any `claude mcp add` / codex config a user copied to wire their OWN terminal
 * into the local server. Stored under userData (user-owned, localhost-only).
 */
function persistedConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp-local.json');
}

/** Read the persisted { secret, port }, or {} if missing/unreadable. */
function loadPersisted(): { secret?: string; port?: number } {
  try {
    const raw = fs.readFileSync(persistedConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out: { secret?: string; port?: number } = {};
      if (typeof parsed.secret === 'string' && parsed.secret.length >= 16) {
        out.secret = parsed.secret;
      }
      if (typeof parsed.port === 'number' && parsed.port > 0) out.port = parsed.port;
      return out;
    }
  } catch {
    /* missing / unreadable — fall back to fresh values */
  }
  return {};
}

/** Persist the live secret + bound port (best-effort; never throws). */
function savePersisted(sec: string, port: number): void {
  try {
    fs.writeFileSync(
      persistedConfigPath(),
      JSON.stringify({ secret: sec, port }),
      { mode: 0o600 },
    );
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mcp] could not persist local config:', e?.message || e);
  }
}

/** Bind the http server (preferring `preferredPort`) and refresh connection info. */
async function bind(preferredPort = 0): Promise<void> {
  // Reuse a persisted secret across restarts so copied external configs keep
  // working; only mint a new one on first ever run.
  if (!secret) secret = loadPersisted().secret || randomBytes(24).toString('hex');
  const factory = createMcpHttpServer({
    tools: buildAppMcpTools(),
    secret,
    allowedOrigins: extensionAllowedOrigins(),
    getHealth: () => ({
      port: handle?.port ?? null,
      // Lets the extension distinguish "up but index/model still warming"
      // from ready — it can skip the tools/call entirely while warming.
      ready: isLocalSearchReady(),
    }),
    onError: (err, ctx) => {
      // eslint-disable-next-line no-console
      console.warn(`[mcp] ${ctx.method} ${ctx.tool ?? ''} failed:`, (err as any)?.message || err);
    },
    onCall: ({ tool, durationMs, ok, reason }) => {
      // Per-call telemetry — surface slow/failing tools without spamming success.
      if (!ok || durationMs > 2_000) {
        // eslint-disable-next-line no-console
        console.log(
          `[mcp] tool ${tool} ${ok ? 'ok' : 'FAIL'} in ${durationMs}ms${reason ? ` — ${reason}` : ''}`,
        );
      }
    },
    onUnexpectedClose: (reason) => {
      if (stopped || restarting) return;
      // eslint-disable-next-line no-console
      console.warn(`[mcp] server died (${reason}) — restarting`);
      void restart();
    },
  });

  // Port preference order: the prior port (keeps codex/claude config and the
  // extension's cached port valid across restarts) → the fixed extension
  // range → ephemeral as a last resort.
  const candidates: number[] = [];
  if (preferredPort > 0) candidates.push(preferredPort);
  for (let p = EXTENSION_PORT_RANGE_START; p <= EXTENSION_PORT_RANGE_END; p += 1) {
    if (p !== preferredPort) candidates.push(p);
  }
  candidates.push(0);

  let h: McpServerHandle | null = null;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      h = await factory.listen(candidate);
      break;
    } catch {
      // port taken/unbindable — try the next one
    }
  }
  if (!h) throw new Error('mcp: could not bind any port');
  handle = h;
  const codexHome = writeCodexConfig(h.url);
  info = {
    url: h.url,
    port: h.port,
    secret,
    codexHome,
    claudeMcpConfig: buildClaudeMcpConfig(h.url, secret),
  };
  // Remember the secret + the port we actually got so the next launch reuses
  // them (keeps any user-copied external `claude mcp add` / codex config valid).
  savePersisted(secret, h.port);
  pingFails = 0;
  // eslint-disable-next-line no-console
  console.log(`[mcp] listening on ${h.url}`);
}

/** JSON-RPC `ping` against our own endpoint — the real liveness probe. */
function selfPing(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!handle || !secret) {
      resolve(false);
      return;
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: handle.port,
        path: '/mcp',
        method: 'POST',
        timeout: PING_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/** Tear down the current server and rebind (preferring the same port). */
async function restart(): Promise<void> {
  if (stopped || restarting) return;
  restarting = true;
  const preferredPort = handle?.port ?? 0;
  try {
    if (handle) await handle.close().catch(() => undefined);
  } finally {
    handle = null;
  }
  try {
    await bind(preferredPort);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[mcp] restart failed:', e?.message || e);
  } finally {
    restarting = false;
  }
}

function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(async () => {
    if (stopped || restarting) return;
    // Cheap check first: if it's not even listening, restart immediately.
    if (!handle || !handle.listening()) {
      void restart();
      return;
    }
    const ok = await selfPing();
    if (ok) {
      pingFails = 0;
      return;
    }
    pingFails += 1;
    if (pingFails >= MAX_PING_FAILS) {
      pingFails = 0;
      // eslint-disable-next-line no-console
      console.warn('[mcp] watchdog: server unresponsive — restarting');
      void restart();
    }
  }, WATCHDOG_MS);
  // Don't let the watchdog keep the process alive on its own.
  watchdog.unref?.();
}

let resumeHooked = false;

/**
 * Shrink the post-sleep blind window: without this, a server that died across
 * suspend is only noticed by the watchdog after up to ~60–90s (two missed
 * 30s pings). On wake, probe immediately and heal.
 */
function hookPowerResume(): void {
  if (resumeHooked) return;
  resumeHooked = true;
  try {
    powerMonitor.on('resume', () => {
      if (stopped || restarting) return;
      void (async () => {
        const ok = handle?.listening() ? await selfPing() : false;
        if (!ok) {
          // eslint-disable-next-line no-console
          console.warn('[mcp] post-resume probe failed — restarting');
          void restart();
        }
      })();
    });
  } catch {
    // powerMonitor unavailable (e.g. tests) — watchdog still covers us.
  }
}

/** Start the MCP server (idempotent) and its auto-heal watchdog. */
export async function startAppMcpServer(): Promise<McpConnectionInfo> {
  if (info && handle) return info;
  stopped = false;
  // Prefer the port we bound last launch so the URL stays stable across full
  // app restarts (not just in-session watchdog restarts).
  await bind(loadPersisted().port || 0);
  startWatchdog();
  hookPowerResume();
  return info as McpConnectionInfo;
}

/** Current connection info, or null if the server isn't up yet. */
export function getMcpConnectionInfo(): McpConnectionInfo | null {
  return info;
}

/** Stop the watchdog and the server (called on app quit). */
export async function stopAppMcpServer(): Promise<void> {
  stopped = true;
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (handle) await handle.close().catch(() => undefined);
  handle = null;
  info = null;
}
