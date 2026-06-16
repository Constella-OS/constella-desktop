/**
 * CLI agent runners — spawn the `claude` or `codex` binary and parse their
 * streaming JSON stdout into NormalizedEvents. Each CLI is its own child
 * process, so heavy work is already isolated from the main thread.
 *
 * Ported from agents-slack `src/main/agentRunner.ts`:
 *  - probe-based binary detection (don't trust `which`),
 *  - stripped child env (no NODE_OPTIONS / ts-node leakage),
 *  - NDJSON stdout parser with partial-chunk buffer + per-CLI normalization,
 *  - SIGTERM on cancel/timeout,
 *  - emit-via-callback (runner.ts owns IPC fan-out; runOnce reuses the path).
 *
 * MCP ("bring your brain"): the in-app MCP server (src/main/mcp) exposes the
 * user's knowledge base as tools. Codex inherits it via a per-app
 * CODEX_HOME/config.toml we own (so we don't clobber the user's global config);
 * Claude gets it via an inline `--mcp-config` JSON. Both are sourced from
 * getMcpConnectionInfo(); when the server isn't up yet the CLIs just run
 * without the brain tools (still fully functional).
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { NormalizedEvent } from '../../utils/providers/types';
import { getMcpConnectionInfo, CODEX_MCP_TOKEN_ENV } from '../mcp';

type CliKind = 'claude' | 'codex';

const binaryCache: Partial<Record<CliKind, string | null>> = {};

const DEFAULT_PROBE_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

function probePathDirs(): string[] {
  const fromEnv = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((p) => p && p !== '.');
  const all = [...DEFAULT_PROBE_DIRS, ...fromEnv];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of all) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch {
      /* not a dir */
    }
  }
  return out;
}

/** Probe disk for an executable by name (don't trust `which`). */
function findBinary(name: string): string | null {
  for (const dir of probePathDirs()) {
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      // eslint-disable-next-line no-bitwise
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

function detectBinary(kind: CliKind, force = false): string | null {
  if (!force && Object.prototype.hasOwnProperty.call(binaryCache, kind)) {
    return binaryCache[kind] ?? null;
  }
  const found = findBinary(kind);
  binaryCache[kind] = found;
  return found;
}

/** Probe disk for the `claude` binary. Cached. */
export function detectClaudeBinary(force = false): string | null {
  return detectBinary('claude', force);
}

/** Probe disk for the `codex` binary. Cached. */
export function detectCodexBinary(force = false): string | null {
  return detectBinary('codex', force);
}

function buildChildEnv(kind: CliKind): NodeJS.ProcessEnv {
  // Strip dev-time loader envs (tsx / ts-node leak via NODE_OPTIONS) and give
  // the CLI a real PATH built from the probe dirs.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.TS_NODE_PROJECT;
  delete env.TS_NODE_TRANSPILE_ONLY;
  delete env.NODE_LOADER;
  delete env.ELECTRON_RUN_AS_NODE;
  env.PATH = probePathDirs().join(path.delimiter);
  if (kind === 'codex') {
    const mcp = getMcpConnectionInfo();
    // Point codex at our per-app CODEX_HOME (config.toml has the MCP server) and
    // hand it the bearer token via the env var that config.toml references.
    if (mcp?.codexHome) {
      env.CODEX_HOME = mcp.codexHome;
      env[CODEX_MCP_TOKEN_ENV] = mcp.secret;
    }
  }
  return env;
}

/**
 * Merge the user's own globally-configured MCP servers into our inline
 * constella mcp-config JSON, so agents can call the same MCP tools the user has
 * connected in their Claude Code. Reads the top-level `mcpServers` map from
 * ~/.claude.json (where `claude mcp add -s user` stores global servers). Our
 * constella entry always wins on a name collision. Returns the base config
 * unchanged if the user file is missing or unparseable — agents still get the
 * knowledge-base tools, just not the user's extra servers.
 */
function mergeUserClaudeMcpServers(baseConfigJson: string): string {
  try {
    const base = JSON.parse(baseConfigJson);
    const userPath = path.join(os.homedir(), '.claude.json');
    const userServers = JSON.parse(fs.readFileSync(userPath, 'utf8'))?.mcpServers;
    if (userServers && typeof userServers === 'object') {
      // user servers first, ours spread last so constella can't be shadowed.
      base.mcpServers = { ...userServers, ...base.mcpServers };
    }
    return JSON.stringify(base);
  } catch {
    return baseConfigJson;
  }
}

function buildClaudeArgs(opts: {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  /** Background/lightweight: skip MCP wiring (the call needs no KB tools). */
  noMcp?: boolean;
}): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    // Only the project scope — we deliberately DON'T pull `user` here, so the
    // agent doesn't inherit the user's global CLAUDE.md / settings / hooks
    // (those can fire unexpectedly in a headless run). User MCP servers are
    // merged in explicitly below via the config JSON instead.
    '--setting-sources',
    'project',
    // Headless --print mode can't show a permission prompt, so any tool that
    // isn't pre-approved would auto-deny. These are the user's OWN agents,
    // running in their OWN folder; we want them to freely write scaffolding
    // (CLAUDE.md, state.md, drafts, learnings/), search the web, and call every
    // MCP tool we wire in. So skip prompts entirely — equivalent to
    // --permission-mode bypassPermissions. (Refuses only under root/sudo, which
    // the desktop app never is; allow rules become no-ops, deny rules still
    // apply.)
    '--dangerously-skip-permissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  // Wire MCP: our in-app constella server PLUS every server the user has
  // configured globally in their own Claude Code (~/.claude.json). We merge
  // them into one config and keep --strict-mcp-config so the agent sees exactly
  // {constella + user servers} and nothing else from disk. SKIPPED for
  // background calls (file-graph): the classifier gets its candidates inline, so
  // loading MCP only adds startup cost + tool-call stalls.
  const mcp = opts.noMcp ? null : getMcpConnectionInfo();
  if (mcp) {
    args.push(
      '--mcp-config',
      mergeUserClaudeMcpServers(mcp.claudeMcpConfig),
      '--strict-mcp-config',
    );
  }
  // NOTE: the prompt is NOT appended here — it's fed via stdin in runClaudeCli.
  // --mcp-config is variadic and would otherwise swallow a trailing positional
  // prompt ("Input must be provided…").
  return args;
}

function buildCodexArgs(opts: {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  bypass?: boolean;
}): string[] {
  const args = ['exec', '--skip-git-repo-check', '--json'];
  // Sandbox: workspace-write is the safe default; bypass only on explicit opt-in.
  if (opts.bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--sandbox', 'workspace-write');
  if (opts.model) args.push('--model', opts.model);
  if (opts.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  // codex has no system-prompt flag — fold it into the prompt.
  const full = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\nUser: ${opts.prompt}`
    : opts.prompt;
  args.push(full);
  return args;
}

/** Normalize one parsed claude stream-json line. Unknown payloads -> `raw`. */
function normalizeClaude(obj: any): NormalizedEvent | null {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'stream_event') {
    const ev = obj.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return { type: 'text-delta', text: ev.delta.text || '' };
    }
    return { type: 'raw', raw: obj };
  }
  if (obj.type === 'assistant' && obj.message?.content) {
    return { type: 'meta', message: 'assistant.complete' };
  }
  if (obj.type === 'tool_use' || obj.type === 'tool_call') {
    return { type: 'tool-call', tool: obj.name || obj.tool || 'tool' };
  }
  if (obj.type === 'tool_result') {
    return { type: 'tool-result', tool: obj.tool_use_id || 'tool' };
  }
  if (
    obj.type === 'system' &&
    (obj.subtype === 'init' ||
      obj.subtype === 'hook_started' ||
      obj.subtype === 'hook_response')
  ) {
    return null;
  }
  if (obj.type === 'result') return { type: 'meta', message: 'result' };
  if (obj.type === 'error') {
    return { type: 'error', message: obj.message || obj.error || 'claude error' };
  }
  return { type: 'raw', raw: obj };
}

/**
 * codex `exec --json` normalizer. Stateful: codex streams `item.delta`
 * (agent_message_delta) AND emits a final `item.completed` (agent_message) that
 * duplicates the streamed text. So once we've seen deltas, the completed message
 * is surfaced as meta (not re-rendered); if no deltas streamed, it IS the answer.
 */
function makeCodexNormalizer(): (obj: any) => NormalizedEvent | null {
  let sawDelta = false;
  return (obj: any) => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'item.delta' && obj.item?.type === 'agent_message_delta') {
      sawDelta = true;
      return { type: 'text-delta', text: obj.delta || obj.text || '' };
    }
    if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
      const text = obj.item.text || obj.item.content || '';
      return sawDelta
        ? { type: 'meta', message: 'agent_message.complete' }
        : { type: 'text', text };
    }
    if (obj.type === 'turn.completed') return { type: 'meta', message: 'turn.completed' };
    if (
      obj.type === 'turn.started' ||
      obj.type === 'item.started' ||
      obj.item?.type === 'reasoning'
    ) {
      return null;
    }
    if (obj.type === 'error') {
      return { type: 'error', message: obj.message || 'codex error' };
    }
    return { type: 'raw', raw: obj };
  };
}

function makeLineBuffer(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
      i = buf.indexOf('\n');
    }
  };
}

export interface CliRunHandle {
  promise: Promise<{ finalText: string }>;
  cancel: () => void;
  /** Deferred-stdin (pre-warm) only: feed the prompt + swap in the real event
   *  sink, which actually starts the run. No-op if already fed / exited. */
  feedPrompt?: (prompt: string, onEvent: (ev: NormalizedEvent) => void) => void;
  /** Whether the child is still running (false after exit/error/cancel). claude
   *  --print self-aborts ~3s after spawn if stdin hasn't been fed, so a caller
   *  must check this before reusing a pre-warmed process. */
  alive?: () => boolean;
}

/**
 * Shared spawn + stream core for both CLIs. `normalize` parses each NDJSON line
 * into a NormalizedEvent; text-delta appends to finalText, a whole-message
 * `text` replaces it. Resolves with the assembled text on clean exit.
 */
function spawnCliRun(
  cfg: {
    kind: CliKind;
    binary: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    normalize: (obj: any) => NormalizedEvent | null;
    timeoutMs?: number;
    /** Working directory for the child. Agents pass their own folder so files
     *  the CLI writes are visible in the Memories browser. Defaults to tmpdir
     *  (preserves existing recall/Stella behavior when unset). */
    cwd?: string;
    /** Prompt to feed via stdin instead of as a positional arg. Used for claude
     *  because its `--allowedTools`/`--mcp-config` are variadic and would
     *  swallow a trailing positional prompt. */
    stdin?: string;
    /** Pre-warm: spawn the process now but DON'T feed/end stdin yet — the caller
     *  feeds the prompt later via the handle's feedPrompt (which starts the run
     *  timer + event stream). claude self-aborts ~3s after spawn if unfed. */
    deferStdin?: boolean;
  },
  onEvent: (ev: NormalizedEvent) => void,
): CliRunHandle {
  let proc: ChildProcess | null = null;
  let cancelled = false;
  let exited = false;
  let started = false; // stdin fed + run timer armed
  let timer: NodeJS.Timeout | null = null;
  // Mutable so a pre-warmed run can swap in the real event sink at feed time
  // (claude emits nothing before stdin EOF, so no events are lost pre-feed).
  let emit = onEvent;

  // Arm the wall-clock timeout. For a pre-warmed proc this starts at FEED time,
  // not spawn time, so the budget covers the actual run, not the warm wait.
  const armTimeout = () => {
    if (!cfg.timeoutMs || cfg.timeoutMs <= 0 || timer) return;
    timer = setTimeout(() => {
      cancelled = true;
      try {
        proc?.kill('SIGTERM');
        // claude/codex can ignore SIGTERM (mid API call) — force-kill shortly after.
        setTimeout(() => {
          try {
            proc?.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }, 2000);
      } catch {
        /* gone */
      }
    }, cfg.timeoutMs);
  };

  // Feed stdin (the prompt) + arm the timeout. Idempotent.
  const feed = (prompt?: string) => {
    if (started) return;
    started = true;
    try {
      if (prompt != null) proc?.stdin?.write(prompt);
      proc?.stdin?.end();
    } catch {
      /* already closed */
    }
    armTimeout();
  };

  const promise = new Promise<{ finalText: string }>((resolve, reject) => {
    // Resolve the working dir, ensuring it exists — spawn throws ENOENT on a
    // missing cwd. Fall back to tmpdir if the agent folder can't be created.
    let cwd = cfg.cwd || os.tmpdir();
    if (cfg.cwd) {
      try {
        fs.mkdirSync(cfg.cwd, { recursive: true });
      } catch {
        cwd = os.tmpdir();
      }
    }
    try {
      proc = spawn(cfg.binary, cfg.args, {
        cwd,
        env: cfg.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      reject(new Error(`spawn failed: ${e?.message || e}`));
      return;
    }

    let finalText = '';
    let stderrTail = '';

    const onLine = (line: string) => {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // non-JSON line, ignore
      }
      const ev = cfg.normalize(obj);
      if (!ev) return;
      if (ev.type === 'text-delta' && ev.text) finalText += ev.text;
      else if (ev.type === 'text' && ev.text) finalText = ev.text;
      emit(ev);
    };
    const lineFeed = makeLineBuffer(onLine);
    proc.stdout?.on('data', (chunk: Buffer) => lineFeed(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    proc.on('error', (err) => {
      exited = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code, signal) => {
      exited = true;
      if (timer) clearTimeout(timer);
      if (cancelled) {
        reject(new Error('cancelled'));
        return;
      }
      if (code === 0) {
        resolve({ finalText });
      } else {
        reject(
          new Error(stderrTail.trim() || `${cfg.kind} exited with ${code ?? signal}`),
        );
      }
    });

    // Normal path: feed the prompt immediately (identical to before). Pre-warm
    // path (deferStdin): wait for feedPrompt().
    if (!cfg.deferStdin) feed(cfg.stdin ?? undefined);
  });

  const cancel = () => {
    cancelled = true;
    try {
      proc?.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };

  const feedPrompt = (prompt: string, newEmit: (ev: NormalizedEvent) => void) => {
    emit = newEmit;
    feed(prompt);
  };
  const alive = () => proc != null && !exited && !cancelled;

  return { promise, cancel, feedPrompt, alive };
}

/** Spawn `claude`, stream NormalizedEvents to `onEvent`, resolve with full text. */
export function runClaudeCli(
  opts: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    timeoutMs?: number;
    thinkingTokens?: number;
    cwd?: string;
    /** Background/lightweight: skip MCP wiring. */
    noMcp?: boolean;
    /** Pre-warm: spawn now, feed the prompt later via handle.feedPrompt. */
    deferStdin?: boolean;
  },
  onEvent: (ev: NormalizedEvent) => void,
): CliRunHandle {
  const binary = detectClaudeBinary();
  if (!binary) {
    return {
      promise: Promise.reject(new Error('claude CLI not found on disk')),
      cancel: () => {},
    };
  }
  const env = buildChildEnv('claude');
  if (opts.thinkingTokens) env.MAX_THINKING_TOKENS = String(opts.thinkingTokens);
  return spawnCliRun(
    {
      kind: 'claude',
      binary,
      args: buildClaudeArgs(opts),
      env,
      normalize: normalizeClaude,
      timeoutMs: opts.timeoutMs,
      cwd: opts.cwd,
      // Prompt via stdin — see buildClaudeArgs note (variadic flags).
      stdin: opts.prompt,
      deferStdin: opts.deferStdin,
    },
    onEvent,
  );
}

/** Spawn `codex exec`, stream NormalizedEvents to `onEvent`, resolve with full text. */
export function runCodexCli(
  opts: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    reasoningEffort?: string;
    bypass?: boolean;
    timeoutMs?: number;
    cwd?: string;
  },
  onEvent: (ev: NormalizedEvent) => void,
): CliRunHandle {
  const binary = detectCodexBinary();
  if (!binary) {
    return {
      promise: Promise.reject(new Error('codex CLI not found on disk')),
      cancel: () => {},
    };
  }
  return spawnCliRun(
    {
      kind: 'codex',
      binary,
      args: buildCodexArgs(opts),
      env: buildChildEnv('codex'),
      normalize: makeCodexNormalizer(),
      timeoutMs: opts.timeoutMs,
      cwd: opts.cwd,
    },
    onEvent,
  );
}
