/**
 * Apply a provider NormalizedEvent to the Stella chat store.
 *
 * Shared by the bridged (local / claude-cli) recall path so a local or CLI
 * answer renders in the SAME chat surface as a cloud answer. The cloud path
 * keeps its own WS handler (which does extra cloud-only bookkeeping like
 * chat-id remap + credits), but both speak the same NormalizedEvent vocabulary
 * via stellaEventToNormalized.
 */
import useStellaChat from '../stores/StellaChatStore';
import type { PersonalizedUIData, MindMapData } from '../stella/v2/types';
import type { NormalizedEvent } from './types';

export function applyNormalizedToChat(ev: NormalizedEvent): void {
  const s = useStellaChat.getState();
  switch (ev.type) {
    case 'text-delta':
    case 'text':
      // Both append: bridged providers stream deltas; a whole-message 'text'
      // only arrives when nothing streamed, so appending is still correct.
      s.setToolStatus(null);
      if (ev.text) s.appendToStreamingMessage(ev.text);
      break;
    case 'tool-call':
      s.setToolStatus({
        toolName: ev.tool,
        status: ev.status || 'Working…',
        integration: ev.integration,
      });
      break;
    case 'ui': {
      s.setToolStatus(null);
      const id = useStellaChat.getState().currentStreamingMessageId;
      if (!id) break;
      if (ev.kind === 'personalized_ui') {
        s.setMessageUiData(id, ev.data as PersonalizedUIData);
      } else {
        s.setMessageMindMapData(id, ev.data as MindMapData);
      }
      break;
    }
    case 'sources': {
      // Attach citation pills to the currently-streaming answer.
      const id = useStellaChat.getState().currentStreamingMessageId;
      if (id && ev.citations?.length) s.setMessageCitations(id, ev.citations);
      break;
    }
    case 'done':
      s.setToolStatus(null);
      s.finalizeStreamingMessage();
      break;
    case 'error':
      s.setToolStatus(null);
      s.finalizeStreamingMessage();
      break;
    // tool-result / meta / raw: nothing to render today.
    default:
      break;
  }
}
