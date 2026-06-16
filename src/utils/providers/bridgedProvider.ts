/**
 * Bridged provider — renderer side of the local / claude-cli backends.
 *
 * Generates a runId, subscribes to the main process's `provider:event` /
 * `provider:status` channels, invokes `provider:run`, and exposes the stream as
 * an async iterable of NormalizedEvents. Inference happens in main (local
 * utilityProcess) or a CLI child process, so the renderer never blocks.
 *
 * Mirrors agents-slack `useAgentStream`, reshaped as a pull-based async iterator
 * so callers can `for await (const ev of provider.run(req))`.
 */
import { v4 as uuidv4 } from 'uuid';

import {
  PROVIDER_IPC,
  type NormalizedEvent,
  type Provider,
  type ProviderId,
  type ProviderRequest,
  type ProviderEventPayload,
  type ProviderStatusPayload,
} from './types';

// Loosely-typed bridge — preload exposes invoke(method, args) and on(channel, fn)->unsub.
function ipc(): any {
  return (window as any).electron?.ipcRenderer;
}

async function* ipcRunStream(
  req: ProviderRequest,
  signal?: AbortSignal,
): AsyncGenerator<NormalizedEvent> {
  const runId = req.runId as string;
  const bridge = ipc();
  if (!bridge) {
    yield { type: 'error', message: 'IPC bridge unavailable (web build?)' };
    return;
  }

  // Pull-queue: IPC callbacks push; the generator awaits when the queue drains.
  const queue: NormalizedEvent[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const offEvent = bridge.on(
    PROVIDER_IPC.event,
    (payload: ProviderEventPayload) => {
      if (!payload || payload.runId !== runId) return;
      queue.push(payload.event);
      notify();
    },
  );
  const offStatus = bridge.on(
    PROVIDER_IPC.status,
    (payload: ProviderStatusPayload) => {
      if (!payload || payload.runId !== runId) return;
      if (payload.phase === 'error') {
        queue.push({ type: 'error', message: payload.error || 'provider error' });
      } else if (payload.phase === 'cancelled') {
        queue.push({ type: 'done' });
      }
      // 'done' status follows a 'done' event we already queued; just terminate.
      if (payload.phase !== 'running') {
        finished = true;
        notify();
      }
    },
  );

  const onAbort = () => {
    bridge.invoke(PROVIDER_IPC.cancel, runId).catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    // Kick off the run (fire-and-forget; events arrive over the channels above).
    bridge.invoke(PROVIDER_IPC.run, req).catch((e: any) => {
      queue.push({ type: 'error', message: e?.message || String(e) });
      finished = true;
      notify();
    });

    // Drain until finished AND the queue is empty.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as NormalizedEvent;
      }
      if (finished) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    offEvent?.();
    offStatus?.();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Build a renderer-side Provider for a main-bridged backend (local / claude-cli). */
export function createBridgedProvider(id: ProviderId, label: string): Provider {
  return {
    id,
    label,
    async available(): Promise<boolean> {
      try {
        return Boolean(await ipc()?.invoke(PROVIDER_IPC.detect, id));
      } catch {
        return false;
      }
    },
    run(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<NormalizedEvent> {
      const runId = req.runId || uuidv4();
      return ipcRunStream({ ...req, providerId: id, runId }, signal);
    },
  };
}
