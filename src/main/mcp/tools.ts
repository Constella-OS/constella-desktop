/**
 * Constella MCP tools — the surface local CLI agents (claude / codex) use to
 * "bring the user's brain" into a run. Each tool is a thin adapter:
 *   - search_notes / get_note round-trip to the renderer (see bridge.ts) so we
 *     reuse the app's real backend-first hybrid search + RxDB hydration instead
 *     of reimplementing retrieval in main.
 *   - list_sources reads the file-index registry directly (pure main-side).
 *
 * Keep responses small — every byte the CLI receives is paid for in tokens.
 */
import type { McpTool } from './server';
import { mcpRendererRequest } from './bridge';
import { listSources } from '../file-index/sources';
import { searchLocalNotes } from './local-search';
import { recentNotes, listTags } from './recent';

export function buildAppMcpTools(): McpTool[] {
  return [
    {
      // LOCAL-ONLY search, resolved entirely in the main process (no renderer,
      // no cloud). Built for the Chrome extension bridge, which runs its own
      // cloud search and merges client-side; also usable by CLI agents that
      // want device-only results. Accepts multiple queries so one round-trip
      // covers a whole expanded-query set.
      name: 'search_local_notes',
      description:
        "Search ONLY the data on this device (notes and locally-indexed files in the local vector index) — no cloud results. Returns ranked hits with id, title, snippet, type, score, and `via` ('query' = vector match, 'tag' = pulled in by the tags filter). Accepts up to 12 queries in one call, run verbatim (no re-expansion); pass your expanded set together instead of calling repeatedly. Optionally pass `tags`: the newest ~30 notes carrying any of those tag names are folded into the SAME result list (so one call covers semantic queries AND tag retrieval). You can pass tags with no queries to just get the recent notes on those tags. status='warming' means the local index/model is still loading — treat query results as empty and do not retry in a tight loop (tag results still return while warming).",
      inputSchema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 12 natural-language search queries (run verbatim, merged + deduped server-side).',
          },
          query: { type: 'string', description: 'Single-query convenience alternative to `queries`.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Tag names — the newest ~30 notes carrying any of these are merged into the result list (use list_tags / recent_tags to get exact names). Optional; can be used without queries.",
          },
          limit: { type: 'number', description: 'Max query (vector) hits to return (default 8, max 20). Tag notes are added on top.' },
        },
      },
      handler: async (args) => {
        const queries = Array.isArray(args.queries)
          ? (args.queries as unknown[]).map((q) => String(q ?? ''))
          : [];
        if (!queries.length && args.query) queries.push(String(args.query));
        const tagNames = Array.isArray(args.tags)
          ? (args.tags as unknown[]).map((t) => String(t ?? ''))
          : [];
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
        return searchLocalNotes({ queries, limit, tagNames });
      },
    },
    {
      name: 'search_notes',
      description:
        "Search the user's Constella knowledge base (their notes, captured thoughts, and locally-indexed files). Returns ranked hits with a title, a short snippet, and an id. Use this whenever the user refers to their own notes/knowledge, or to ground an answer in what they've saved. Call get_note with a returned id to read the full content.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          limit: { type: 'number', description: 'Max hits to return (default 8, max 20).' },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return { hits: [] };
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
        // Renderer returns already-compacted hits (title/snippet/id/type/score).
        const hits = (await mcpRendererRequest('search', { query, limit })) as unknown[];
        return { hits: Array.isArray(hits) ? hits : [] };
      },
    },
    {
      // Capture from the Chrome extension (and CLI agents): creates a note
      // through the renderer's REAL creation pipeline so it gets everything a
      // natively-created note gets — SQLite persistence, embedding → LanceDB,
      // file-graph auto-connections (via db:changed → noteIngest → scheduler),
      // AND the cloud push (rxdbAddNote → insert_record, offline retry queue,
      // backend auto-tags). Cloud pushes are device-id-stamped so relay_pull
      // never echoes them back (see note-push-policy.ts — the
      // DISABLE_DESKTOP_NOTE_CLOUD_PUSH emergency brake gates this off if the
      // echo loop ever resurfaces). The renderer is required (it owns the tag
      // store); when the window isn't available the call rejects and the
      // extension falls back to its direct cloud path instead.
      name: 'create_note',
      description:
        "Save a new note/thought/web clip into the user's Constella knowledge base. It is persisted locally, indexed for search, auto-connected to related notes, and synced to the user's cloud account. Returns the created note's uniqueid.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title (or the captured/selected text).' },
          content: { type: 'string', description: 'Note body (plain text or markdown). Optional.' },
          sourceUrl: { type: 'string', description: 'URL the capture came from. Optional.' },
          sourceDomain: { type: 'string', description: 'Domain of sourceUrl. Optional.' },
          noteType: {
            type: 'string',
            description: "Capture kind: 'web_clip' (selection) | 'web_article' (full page) | omit for a plain thought.",
          },
          tagNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag names to attach (found-or-created by name). Optional.',
          },
          uniqueid: {
            type: 'string',
            description:
              'Caller-supplied note id. The extension passes one so an ambiguous timeout + cloud fallback dedupes to a single note (backend insert_record dedupes by uniqueid). Optional.',
          },
        },
        required: ['title'],
      },
      handler: async (args) => {
        const title = String(args.title ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!title && !content) return { error: 'title or content is required' };
        const tagNames = Array.isArray(args.tagNames)
          ? (args.tagNames as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean)
          : [];
        const result = await mcpRendererRequest(
          'create-note',
          {
            title,
            content,
            sourceUrl: String(args.sourceUrl ?? '').trim(),
            sourceDomain: String(args.sourceDomain ?? '').trim(),
            noteType: String(args.noteType ?? '').trim(),
            tagNames,
            uniqueid: String(args.uniqueid ?? '').trim(),
          },
          10_000,
        );
        return result ?? { error: 'creation failed' };
      },
    },
    {
      // Local-first PDF capture from the Chrome extension. Saves the actual PDF
      // into the user's knowledge base via the SAME pipeline as the in-app
      // "+ Add → PDF upload" (local file storage + text extraction + AI
      // title/summary + embedding + cloud sync), so the user can open the
      // preserved file and it's indexed for search. The extension sends the PDF
      // bytes it already fetched (pdfBase64, with the user's session) so
      // login-gated PDFs work; if omitted (too large), the desktop re-fetches
      // from sourceUrl. Returns the created note's uniqueid.
      name: 'create_pdf',
      description:
        "Save a PDF web clip into the user's Constella knowledge base. The PDF file is preserved locally (openable later), its text extracted + chunked + indexed, and a title/summary generated — same as adding a PDF in the app. Returns the created note's uniqueid.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PDF title (or the document/file name).' },
          content: { type: 'string', description: 'Pre-extracted PDF text, if the caller already has it. Optional.' },
          sourceUrl: { type: 'string', description: 'URL the PDF came from (used to re-fetch if bytes are omitted, and as the openable link).' },
          sourceDomain: { type: 'string', description: 'Domain of sourceUrl. Optional.' },
          pageCount: { type: 'number', description: 'Number of pages. Optional.' },
          tagNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag names to attach (found-or-created by name). Optional.',
          },
          pdfBase64: {
            type: 'string',
            description: 'Raw PDF bytes as base64 (no data-URL prefix). Omit for very large PDFs; the desktop then re-fetches from sourceUrl.',
          },
          uniqueid: {
            type: 'string',
            description: 'Caller-supplied note id so an ambiguous timeout + cloud fallback dedupes to a single note.',
          },
        },
        required: ['title'],
      },
      handler: async (args) => {
        const title = String(args.title ?? '').trim();
        const sourceUrl = String(args.sourceUrl ?? '').trim();
        const pdfBase64 = String(args.pdfBase64 ?? '').trim();
        // Need at least something to locate/store the PDF: bytes or a URL.
        if (!title) return { error: 'title is required' };
        if (!pdfBase64 && !sourceUrl) return { error: 'pdfBase64 or sourceUrl is required' };
        const tagNames = Array.isArray(args.tagNames)
          ? (args.tagNames as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean)
          : [];
        const pageCount = Number(args.pageCount);
        const result = await mcpRendererRequest(
          'create-pdf',
          {
            title,
            content: String(args.content ?? '').trim(),
            sourceUrl,
            sourceDomain: String(args.sourceDomain ?? '').trim(),
            ...(Number.isFinite(pageCount) && pageCount > 0 ? { pageCount } : {}),
            tagNames,
            ...(pdfBase64 ? { pdfBase64 } : {}),
            uniqueid: String(args.uniqueid ?? '').trim(),
          },
          // PDF path is slower than a plain note: persist bytes + extract +
          // summarize + embed. Give the renderer a generous budget.
          20_000,
        );
        return result ?? { error: 'creation failed' };
      },
    },
    {
      name: 'get_note',
      description:
        'Fetch the full content of one note/document from the knowledge base by its id (as returned by search_notes). Returns the title and body text.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The note id (uniqueid) from a search_notes hit.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args.id ?? '').trim();
        if (!id) return { error: 'missing id' };
        const note = await mcpRendererRequest('get-note', { uniqueid: id });
        return note ?? { error: 'not found', id };
      },
    },
    {
      // Time-ordered, NOT a search. Pure main-side (SQLite main-db) — answers
      // even when logged out. Lets an agent see "what is the user working on
      // now" without guessing a query (Riley Phase 3A — pull latest 100).
      name: 'recent_notes',
      description:
        "The user's most recently created/updated notes, newest first (time-ordered, NOT a search). Use to see what they're working on right now before searching. Returns id, title, snippet, type, lastModified, tags. Optionally filter by note types or exclude notes carrying given tag names.",
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max notes to return (default 50, max 200).' },
          noteTypes: {
            type: 'array',
            items: { type: 'string' },
            description: "Only return these note types (e.g. ['note','web_clip']). Omit for all.",
          },
          excludeTagNames: {
            type: 'array',
            items: { type: 'string' },
            description: "Drop notes carrying any of these tag names (e.g. ['personal']). Optional.",
          },
        },
      },
      handler: async (args) =>
        recentNotes({
          limit: Number(args.limit) || undefined,
          noteTypes: Array.isArray(args.noteTypes)
            ? (args.noteTypes as unknown[]).map((t) => String(t ?? ''))
            : undefined,
          excludeTagNames: Array.isArray(args.excludeTagNames)
            ? (args.excludeTagNames as unknown[]).map((t) => String(t ?? ''))
            : undefined,
        }),
    },
    {
      // The user's FULL tag vocabulary (every tag, not just recently-used).
      // Pure main-side. Feed these exact names into search tag filters /
      // created-note tags instead of inventing near-misses (Riley Phase 3B).
      name: 'list_tags',
      description:
        "List ALL of the user's tags (their full tag vocabulary), sorted alphabetically. Use these exact names when searching by tag or tagging notes you create, instead of inventing similar ones. Returns id, name, color.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => listTags(),
    },
    {
      // Hybrid (backend-first) fan-out: many queries → one deduped working set.
      // Complements search_local_notes (local-only, 4-query cap). Bridges to the
      // renderer because the real backend-first search + auth live there.
      name: 'multi_search',
      description:
        "Run a whole set of queries as ONE retrieval across BOTH the cloud knowledge base AND this device's local index, returning a single merged, deduped list. The queries are run as-is (no re-expansion) — pass your already-expanded set of 8–12 instead of calling search_notes repeatedly. Optionally pass `tags`: the most recent notes on those tags are folded into the SAME list (both sources). Each hit carries `source` ('cloud' or 'local'). Returns ranked hits with id, title, snippet, type, score, source.",
      inputSchema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 12 natural-language queries, run together and deduped by id (no re-expansion).',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Tag names — the most recent notes carrying any of these are folded into the result list. Optional; can be used without queries.",
          },
          limitPerQuery: { type: 'number', description: 'Hits per query before merge (default 5, max 20).' },
        },
      },
      handler: async (args) => {
        const queries = Array.isArray(args.queries)
          ? (args.queries as unknown[]).map((q) => String(q ?? '').trim()).filter(Boolean)
          : [];
        const tags = Array.isArray(args.tags)
          ? (args.tags as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean)
          : [];
        if (!queries.length && !tags.length) return { hits: [] };
        const perQuery = Math.min(20, Math.max(1, Number(args.limitPerQuery) || 5));

        // Fire both legs in parallel: cloud via the renderer bridge (backend-
        // first, the source of truth) and on-device via the local index. They
        // search different vector spaces (cloud 768-dim, local EmbeddingGemma
        // 512), so scores are NOT comparable — we merge by uniqueid, never by
        // cross-space score: cloud hits first, then local-only hits appended.
        const [cloudRes, localRes] = await Promise.all([
          mcpRendererRequest('multi-search', { queries, tags, limitPerQuery: perQuery }).catch(
            (e) => {
              console.warn('[multi_search] cloud leg failed:', e?.message || e);
              return { hits: [] };
            },
          ),
          searchLocalNotes({ queries, tagNames: tags, limit: 20 }).catch((e) => {
            console.warn('[multi_search] local leg failed:', e?.message || e);
            return { status: 'ok', hits: [] };
          }),
        ]);

        const cloudHits = Array.isArray((cloudRes as any)?.hits) ? (cloudRes as any).hits : [];
        const localHits = Array.isArray((localRes as any)?.hits) ? (localRes as any).hits : [];

        const seen = new Set<string>();
        const merged: any[] = [];
        for (const h of cloudHits) {
          if (!h?.id || seen.has(h.id)) continue;
          seen.add(h.id);
          merged.push({ ...h, source: 'cloud' });
        }
        for (const h of localHits) {
          if (!h?.id || seen.has(h.id)) continue;
          seen.add(h.id);
          merged.push({ ...h, source: 'local' });
        }
        return {
          hits: merged,
          cloud_count: cloudHits.length,
          local_count: localHits.length,
          // surface a warming signal so the agent knows the local leg is still loading.
          ...((localRes as any)?.status === 'warming' ? { local_status: 'warming' } : {}),
        };
      },
    },
    // ---- Agent management ------------------------------------------------
    {
      name: 'list_agents',
      description:
        "List all agents the user has created. Returns each agent's id, name, title, and a truncated preview of its instructions. Use get_agent to read the full instructions or workflow nodes for a specific agent.",
      inputSchema: { type: 'object', properties: {} },
      handler: async () => mcpRendererRequest('agent:list', {}),
    },
    {
      name: 'get_agent',
      description:
        "Get full details for one agent: name, title, complete instructions, folder, and all workflow nodes (id, title, prompt, kind, connectors). Use this before editing an agent or running its workflow.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id (from list_agents).' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:get', { id: String(args.id ?? '') }),
    },
    {
      name: 'create_agent',
      description:
        "Create a new agent with a name, optional role title, and system instructions. Returns the new agent's id. The agent is immediately visible in the Agents panel and can be run with run_agent_workflow.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short display name (e.g. "Research Assistant").' },
          title: { type: 'string', description: 'Role subtitle shown under the name. Optional.' },
          instructions: { type: 'string', description: 'Full system prompt / behaviour instructions for the agent.' },
          folder: { type: 'string', description: 'Absolute path to the agent’s working directory. Optional.' },
        },
        required: ['name', 'instructions'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:create', {
          name: String(args.name ?? ''),
          title: String(args.title ?? ''),
          instructions: String(args.instructions ?? ''),
          folder: String(args.folder ?? ''),
        }),
    },
    {
      name: 'update_agent',
      description:
        'Update an existing agent’s name, title, instructions, or folder. Pass only the fields you want to change. Use get_agent first to read the current values.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id.' },
          name: { type: 'string', description: 'New display name. Optional.' },
          title: { type: 'string', description: 'New role subtitle. Optional.' },
          instructions: { type: 'string', description: 'New system prompt. Optional.' },
          folder: { type: 'string', description: 'New working directory path. Optional.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const patch: Record<string, string> = {};
        if (args.name !== undefined) patch.name = String(args.name);
        if (args.title !== undefined) patch.title = String(args.title);
        if (args.instructions !== undefined) patch.instructions = String(args.instructions);
        if (args.folder !== undefined) patch.folder = String(args.folder);
        return mcpRendererRequest('agent:update', { id: String(args.id ?? ''), patch });
      },
    },
    {
      name: 'delete_agent',
      description:
        'Permanently delete an agent and all its workflow nodes and chat history. This cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id to delete.' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:delete', { id: String(args.id ?? '') }),
    },
    {
      name: 'run_agent_workflow',
      description:
        "Trigger an agent's automated workflow (its node graph). The run streams into the agent's chat. Returns immediately — check the Agents panel for live progress.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id.' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:run', { id: String(args.id ?? '') }),
    },
    {
      name: 'update_workflow_node',
      description:
        "Update one node in an agent's workflow graph. Use get_agent to list node ids first. You can change the node's title, prompt, or eyebrow label.",
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent id.' },
          nodeId: { type: 'string', description: 'Node id (from get_agent workflow.nodes).' },
          title: { type: 'string', description: 'New node title. Optional.' },
          eyebrow: { type: 'string', description: 'New eyebrow label. Optional.' },
          prompt: { type: 'string', description: 'New node prompt / instructions. Optional.' },
        },
        required: ['agentId', 'nodeId'],
      },
      handler: async (args) => {
        const patch: Record<string, string> = {};
        if (args.title !== undefined) patch.title = String(args.title);
        if (args.eyebrow !== undefined) patch.eyebrow = String(args.eyebrow);
        if (args.prompt !== undefined) patch.prompt = String(args.prompt);
        return mcpRendererRequest('workflow:update-node', {
          agentId: String(args.agentId ?? ''),
          nodeId: String(args.nodeId ?? ''),
          patch,
        });
      },
    },
    {
      name: 'get_agent_chat',
      description:
        "Return an agent's chat history — all messages between the user and the agent, including the output of the latest workflow run (which streams in as an agent-side message). Pass `limit` to cap how many recent messages are returned (default 20). The most recent message is last. Use this to read what an agent produced after run_agent_workflow.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id.' },
          limit: { type: 'number', description: 'Max messages to return, newest last (default 20, max 100).' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:chat-history', {
          id: String(args.id ?? ''),
          limit: Math.min(100, Math.max(1, Number(args.limit) || 20)),
        }),
    },
    {
      name: 'get_agent_status',
      description:
        "Return the current run status of an agent's workflow: phase ('idle'|'running'|'done'|'error'|'cancelled'), error message if any, and duration of the last run in ms. Status resets to idle when the app restarts — for the actual output content, use get_agent_chat.",
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Agent id.' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        mcpRendererRequest('agent:run-status', { id: String(args.id ?? '') }),
    },
    // ---- Sources ---------------------------------------------------------
    {
      name: 'list_sources',
      description:
        'List the local folders Constella indexes into the knowledge base (id, name, path, kind, last sync time, indexed file count). Use this to see what local content is searchable.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const all = await listSources();
        return all.map((s) => ({
          id: s.id,
          name: s.name,
          path: s.path,
          kind: s.kind,
          syncEnabled: s.syncEnabled,
          includeByDefault: s.includeByDefault,
          lastSyncedAt: s.lastSyncedAt,
          lastDocCount: s.lastDocCount,
        }));
      },
    },
  ];
}
