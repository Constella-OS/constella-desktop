/**
 * buildStepCtx — assemble the StepCtx that flows through a pipeline run.
 *
 * Fills auth (userId / accessToken) from the canonical app getters when the
 * caller doesn't pass them, defaults the emit sink to a no-op (for headless /
 * test runs), and sets sensible mode/provider/topK defaults. The renderer recall
 * entry overrides `emit` with the chat-store applier so frames render live.
 */
import { getAccessToken } from '../api/authHeaders';
import { getCurrentUserIdSync } from '../firebase/firebase-auth';
import type {
  MindmapEdge,
  NormalizedEvent,
  StepCtx,
  PipelineMode,
  ProviderId,
  AttachedSource,
  MindmapResult,
} from './types';

export interface BuildStepCtxArgs {
  mode?: PipelineMode;
  provider?: ProviderId;
  userId?: string;
  accessToken?: string;
  signal?: AbortSignal;
  emit?: (event: NormalizedEvent) => void;
  topK?: number;
  excludeTypes?: string[];
  modelId?: string;
  thinkingTokens?: number;
  query?: string;
  chatId?: string | null;
  history?: string;
  cloudChat?: (args: {
    message: string;
    chatId: string;
    graphContext?: unknown;
  }) => Promise<void>;
  attachedSources?: AttachedSource[];
  graphContext?: unknown;
  onMindmap?: (mindmap: MindmapResult) => void;
  onMindmapEdges?: (edges: MindmapEdge[]) => void;
}

const noop = () => undefined;

export function buildStepCtx(args: BuildStepCtxArgs = {}): StepCtx {
  let userId = args.userId;
  let accessToken = args.accessToken;
  // Best-effort fill from the app's auth singletons; never throw if unavailable
  // (web build / pre-login) — steps that need auth self-gate on it.
  try {
    if (!userId) userId = getCurrentUserIdSync() || '';
  } catch {
    userId = userId || '';
  }
  try {
    if (!accessToken) accessToken = getAccessToken() || undefined;
  } catch {
    /* leave undefined */
  }

  return {
    mode: args.mode ?? 'cloud',
    provider: args.provider ?? 'cloud',
    userId: userId || '',
    accessToken,
    signal: args.signal,
    emit: args.emit ?? noop,
    topK: args.topK ?? 20,
    excludeTypes: args.excludeTypes,
    modelId: args.modelId,
    thinkingTokens: args.thinkingTokens,
    query: args.query,
    chatId: args.chatId,
    history: args.history,
    cloudChat: args.cloudChat,
    attachedSources: args.attachedSources,
    graphContext: args.graphContext,
    onMindmap: args.onMindmap,
    onMindmapEdges: args.onMindmapEdges,
  };
}
