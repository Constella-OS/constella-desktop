/**
 * IPC bridge for the main DB — ONE generic channel.
 *
 *   invoke('db:call', { collection, method, args })
 *     -> { ok: true, data } | { ok: false, error }
 *
 * The method whitelist is enforced twice: here (fail fast before touching the
 * worker) and in the worker dispatcher itself. Docs in args/results are raw
 * JSON strings — never parsed on main (see src/shared/main-db-api.ts).
 */
import { ipcMain } from 'electron';

import type { DbCallRequest, DbCallResult } from '../../shared/main-db-api';
import { DB_CALL_CHANNEL, DB_METHODS } from '../../shared/main-db-api';
import { callRepo } from './db';

const SLOW_CALL_MS = 250;

export function registerMainDbHandlers(): void {
  ipcMain.handle(
    DB_CALL_CHANNEL,
    async (event, req: DbCallRequest): Promise<DbCallResult> => {
      const { collection, method, args } = req ?? ({} as DbCallRequest);
      const allowed = (DB_METHODS as any)[collection];
      if (!allowed || !allowed.includes(method)) {
        return { ok: false, error: `unknown db method ${collection}.${method}` };
      }
      const started = Date.now();
      try {
        const data = await callRepo(
          collection,
          method,
          Array.isArray(args) ? args : [],
          event.sender.id,
        );
        const elapsed = Date.now() - started;
        if (elapsed > SLOW_CALL_MS) {
          console.warn(`[main-db] slow db:call ${collection}.${method} took ${elapsed}ms`);
        }
        return { ok: true, data };
      } catch (e: any) {
        console.error(`[main-db] db:call ${collection}.${method} failed:`, e);
        return { ok: false, error: e?.message || String(e) };
      }
    },
  );
}
