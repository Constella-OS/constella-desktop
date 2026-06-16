/**
 * recallInsights — the structured-output contract for the `recall` task's
 * synthesize step. ONE schema, three bindings (cloud response_format / local
 * GBNF grammar / CLI strict-prompt+extractor). Mirrors the cloud ai-search
 * synthesis shape ({title, key_insights, source_ids}) so the UI renders the
 * same regardless of which provider produced it.
 */
import type { PipelineSchema } from '../types';

export const recallInsightsSchema: PipelineSchema = {
  name: 'recall_insights',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: {
        type: 'string',
        description: 'One-sentence headline answer to the query.',
      },
      key_insights: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concise bullet insights grounded in the evidence.',
      },
      source_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'uniqueids of the evidence items actually used.',
      },
    },
    required: ['title', 'key_insights'],
  },
};

/** The shape parseJsonObject should yield for the above schema. */
export interface RecallInsights {
  title: string;
  key_insights: string[];
  source_ids?: string[];
}
