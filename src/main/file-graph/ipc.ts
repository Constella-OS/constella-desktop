/**
 * IPC surface for the knowledge-graph engine + scheduler boot.
 *
 * The structured graph (concepts/themes/edges/docs) lives in the main-side
 * SQLite store (graphDb); the renderer QUERIES it through these handlers:
 *   file-graph:set-provider  → persist the renderer's provider pick for the engine
 *   file-graph:run-now       → manual generation trigger
 *   file-graph:slug-index    → slug → concept/theme id (modal resolves [[wikilinks]])
 *   file-graph:status        → engine availability + counts
 *   file-graph:concepts      → list concept pages (Discoveries graph)
 *   file-graph:themes        → list theme pages
 *   file-graph:page          → one concept/theme page (id → body + sources)
 *   file-graph:subgraph      → a node's neighborhood (edges around it)
 * note↔note auto-connections still mirror to RxDB note arrays (for the canvas)
 * over file-graph:connections (see emit.ts + the renderer coordinator).
 */
import { ipcMain } from 'electron';
import { setGraphProvider, graphProviderAvailable } from './provider';
import { startGraphScheduler, runGraphNow } from './scheduler';
import { startNoteGraphIngest } from './noteIngest';
import { cloudQuotaStatus } from './cloudQuota';
import { inspectFileGraph } from './inspect';
import {
  slugIndexMap,
  allConcepts,
  allThemes,
  getConcept,
  getTheme,
  outgoingEdges,
  allConceptEdges,
  deleteGraphPage,
} from './graphDb';
import { emitGraph } from './emit';
import { removeFromLanceDB } from '../utils/vector-db/vector-db';
import type { ProviderId } from '../../utils/providers/types';

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function registerFileGraphHandlers(): void {
  ipcMain.handle('file-graph:set-provider', async (_e, provider: ProviderId) => {
    await setGraphProvider(provider);
    return { ok: true };
  });

  ipcMain.handle('file-graph:run-now', async () => {
    runGraphNow().catch(() => undefined);
    return { ok: true };
  });

  ipcMain.handle('file-graph:slug-index', async () => slugIndexMap());

  ipcMain.handle('file-graph:status', async () => ({
    available: await graphProviderAvailable(),
    concepts: allConcepts().length,
    themes: allThemes().length,
  }));

  // Concept/theme lists for the Discoveries graph (renderer queries main).
  ipcMain.handle('file-graph:concepts', async () =>
    allConcepts().map((c) => ({
      id: c.id,
      slug: c.slug,
      title: c.title,
      body: c.body,
      sources: parseJson(c.sources_json, [] as any[]),
      status: c.status,
      updated_at: c.updated_at,
    })),
  );

  ipcMain.handle('file-graph:themes', async () =>
    allThemes().map((t) => ({
      id: t.id,
      slug: t.slug,
      title: t.title,
      body: t.body,
      constituents: parseJson(t.constituents_json, [] as string[]),
      // Without this, the Discoveries grid sorts themes as updatedAt=0 and
      // they sink below every concept — i.e. themes never visibly surface.
      updated_at: t.updated_at,
    })),
  );

  ipcMain.handle('file-graph:page', async (_e, id: string) => {
    const c = getConcept(id);
    if (c) {
      return {
        id: c.id,
        slug: c.slug,
        title: c.title,
        body: c.body,
        sources: parseJson(c.sources_json, [] as any[]),
        status: c.status,
        kind: 'concept',
      };
    }
    // Fall back to a theme page (themes cite concepts, not raw notes, so they
    // carry no sources) — lets the shared modal open theme discoveries too.
    const t = getTheme(id);
    if (t) {
      return {
        id: t.id,
        slug: t.slug,
        title: t.title,
        body: t.body,
        sources: [] as any[],
        status: 'live',
        kind: 'theme',
      };
    }
    return null;
  });

  // Delete a concept/theme page (Discoveries card trash / page-modal delete).
  // Tombstones the id so the synth pass never regenerates it, removes the row
  // + slug + its concept-graph edges, drops the LanceDB vector, and broadcasts
  // the deletion so the Discoveries grid + Graph view update live.
  ipcMain.handle('file-graph:delete-page', async (_e, id: string) => {
    if (!id) return { ok: false };
    const existed = deleteGraphPage(id);
    removeFromLanceDB(id).catch(() => undefined);
    emitGraph('file-graph:deletions', { ids: [id] });
    return { ok: existed };
  });

  ipcMain.handle('file-graph:subgraph', async (_e, id: string) =>
    outgoingEdges(id).map((e) => ({
      source: e.source_id,
      target: e.target_id,
      type: e.type,
      strength: e.strength,
      context: e.context,
    })),
  );

  // Whole concept/theme edge set — the Graph view draws every typed link at once.
  ipcMain.handle('file-graph:edges', async () =>
    allConceptEdges().map((e) => ({
      source: e.source_id,
      target: e.target_id,
      type: e.type,
      strength: e.strength,
      context: e.context,
    })),
  );

  // On-demand quality report (also printed automatically at boot). Returns the
  // full report text so it can be triggered from the renderer/devtools.
  ipcMain.handle('file-graph:inspect', async () => inspectFileGraph());

  // Cloud AI quota state for the home banner ("Auto Connections Limit
  // reached") — initial render queries this; live trips arrive over the
  // 'file-graph:quota-exceeded' push (see cloudQuota.ts).
  ipcMain.handle('file-graph:quota-status', async () => cloudQuotaStatus());

  startGraphScheduler();
  // App-created notes (captures, canvas notes, links) → text store + LanceDB,
  // so the connection pass treats them exactly like indexed files.
  startNoteGraphIngest();

  // Boot-time quality snapshot: print what the local engine has ingested +
  // connected so far. Delayed ~45s so LanceDB + the text store have finished
  // initializing (the vector table opens lazily on the first sync/search).
  setTimeout(() => {
    inspectFileGraph().catch(() => undefined);
  }, 45_000);
}
