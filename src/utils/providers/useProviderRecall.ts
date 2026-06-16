/**
 * useProviderRecall — single recall dispatch across all providers.
 *
 * dispatchRecall({ query, chatId, providerId, mode? }):
 *   - 'cloud'      -> existing Stella V2 WebSocket (sendChatMessage). The WS hook
 *                     owns the placeholder + streaming + cloud bookkeeping, so the
 *                     cloud path is byte-for-byte unchanged. (Cloud synthesis is
 *                     NOT in the ai-pipeline yet — no renderer one-shot; it needs
 *                     a backend /pipeline/synthesize endpoint — so cloud stays here.)
 *   - 'local'/'cli'-> run the `recall` RECIPE (src/utils/ai-pipeline) and stream
 *                     its NormalizedEvents into the chat via applyNormalizedToChat.
 *                     The recipe does its own KB retrieval (local + cloud evidence,
 *                     merged per `mode`), ranks it, and synthesizes on the chosen
 *                     provider — so the answer is grounded in real retrieved
 *                     sources (with citation pills) instead of just on-screen nodes.
 *
 * Data `mode` defaults to 'hybrid' (pull from both local files and cloud notes;
 * each search self-gates, so it degrades to whatever is reachable). A future
 * data-mode toggle can override it per call.
 */
import { useCallback } from 'react';

import useStellaChat from '../stores/StellaChatStore';
import { useStellaV2WebSocket } from '../stella/v2/useStellaV2WebSocket';
import {
  createStreamingAssistantMessage,
  buildStructuredGraphContextPayload,
} from '../stella/v2/message-helpers';
import { applyNormalizedToChat } from './applyNormalizedToChat';
import { beginRecallRun } from './recallRunController';
import { recallModelFor } from './recallModels';
import type { ProviderId } from './types';
import { runRecipe, buildStepCtx, aiChat, type PipelineMode } from '../ai-pipeline';
import { trackEvent } from '../analytics';

export interface DispatchRecallArgs {
  query: string;
  chatId: string;
  providerId: ProviderId;
  /** Where evidence comes from. Defaults to 'hybrid' (local + cloud merged). */
  mode?: PipelineMode;
  /** Optional source label for callers that need recall outcome telemetry. */
  analyticsSource?: string;
}

export function useProviderRecall() {
  const { sendChatMessage, isConnected } = useStellaV2WebSocket();
  const addMessage = useStellaChat((s) => s.addMessage);
  const setCurrentStreamingMessageId = useStellaChat(
    (s) => s.setCurrentStreamingMessageId,
  );
  const setIsStreaming = useStellaChat((s) => s.setIsStreaming);

  const dispatchRecall = useCallback(
    async ({
      query,
      chatId,
      providerId,
      mode = 'hybrid',
      analyticsSource,
    }: DispatchRecallArgs) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      const started = Date.now();

      // Abort any in-flight recall run first (its tokens would otherwise stream
      // into this new turn via the global applyNormalizedToChat sink), then close
      // out its placeholder so it doesn't hang with a spinner. Returns the signal
      // we thread into the pipeline below.
      const runSignal = beginRecallRun();
      useStellaChat.getState().finalizeStreamingMessage();

      // Create the streaming placeholder for EVERY provider so the chat shows
      // its searching state while retrieval runs. For cloud the WS send
      // (sendChatMessage) REUSES this exact placeholder — no duplicate bubble.
      const assistantMsg = createStreamingAssistantMessage(chatId);
      addMessage(assistantMsg);
      setCurrentStreamingMessageId(assistantMsg.uniqueid);
      setIsStreaming(true);

      // Immediate feedback while retrieval runs; synthesize clears it on first text.
      applyNormalizedToChat({
        type: 'tool-call',
        tool: 'search',
        status: 'Searching your knowledge…',
      });

      const assistantContent = () =>
        useStellaChat
          .getState()
          .messages.find((m) => m.uniqueid === assistantMsg.uniqueid)
          ?.content ?? '';

      const trackRecallOutcome = (
        eventName: string,
        extra: Record<string, unknown> = {},
      ) => {
        if (!analyticsSource) return;
        const content = assistantContent();
        trackEvent(eventName, {
          query: trimmed,
          query_length: trimmed.length,
          chat_id: chatId,
          provider: providerId,
          mode,
          response: content,
          response_length: content.length,
          duration_ms: Date.now() - started,
          source: analyticsSource,
          ...extra,
        });
      };

      // Cloud: SAME retrieval as every other provider — the aiChat recipe runs
      // query-gen → local+cloud multi-search → filterRank/cap, then chatStream's
      // cloud tail hands the evidence to the Stella WS as retrieved_context on
      // THIS chat turn (the backend folds in its own per-chat message history).
      // The backend never runs its retrieve tool for desktop turns — answers
      // ground on what we send.
      if (providerId === 'cloud') {
        const ctx = buildStepCtx({
          mode,
          provider: 'cloud',
          query: trimmed,
          signal: runSignal,
          chatId,
          emit: applyNormalizedToChat,
          graphContext: buildStructuredGraphContextPayload(),
          cloudChat: ({ message, chatId: targetChatId, graphContext }) =>
            sendChatMessage(
              message,
              targetChatId,
              undefined,
              'desktop_recall',
              (graphContext as { prompt_prefix?: string } | undefined)
                ?.prompt_prefix,
            ),
        });
        try {
          await runRecipe(aiChat, trimmed, ctx);
          trackRecallOutcome('Home Ask AI Chat Response Returned');
        } catch (e: any) {
          applyNormalizedToChat({
            type: 'error',
            message: e?.message || String(e),
          });
          trackRecallOutcome('Home Ask AI Chat Response Errored', {
            error: e?.message || String(e),
          });
        }
        return;
      }

      // Use the model the user picked in Settings → AI Config (lastLoadedModelId).
      // Undefined falls back to getRecommendedModel() in the main process.
      const selectedModelId =
        (typeof localStorage !== 'undefined' &&
          localStorage.getItem('lastLoadedModelId')) ||
        undefined;

      // On-screen graph nodes (with content) — the same payload the cloud WS
      // ships. Folded into the local/CLI prompt so on-device chat is grounded in
      // the nodes currently on the canvas. null when no canvas is open.
      const graphContext = buildStructuredGraphContextPayload();

      // Build the pipeline context: provider + data mode + the live query, with
      // applyNormalizedToChat as the emit sink so frames render into the chat.
      // Follow-up turns go deeper: Sonnet 4.6 + high extended thinking on
      // claude-cli (other providers keep selectedModelId). See recallModelFor().
      const followupModel = recallModelFor(providerId, 'followup');
      const ctx = buildStepCtx({
        mode,
        provider: providerId,
        query: trimmed,
        signal: runSignal,
        modelId: followupModel.model ?? selectedModelId,
        thinkingTokens: followupModel.thinkingTokens,
        emit: applyNormalizedToChat,
        graphContext,
      });

      try {
        await runRecipe(aiChat, trimmed, ctx);
        trackRecallOutcome('Home Ask AI Chat Response Returned');
      } catch (e: any) {
        applyNormalizedToChat({
          type: 'error',
          message: e?.message || String(e),
        });
        trackRecallOutcome('Home Ask AI Chat Response Errored', {
          error: e?.message || String(e),
        });
      }
    },
    [sendChatMessage, addMessage, setCurrentStreamingMessageId, setIsStreaming],
  );

  return { dispatchRecall, isConnected };
}
