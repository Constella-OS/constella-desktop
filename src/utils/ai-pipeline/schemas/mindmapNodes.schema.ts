/**
 * mindmapNodes — node-selection contract for the local/CLI mindmap path. The
 * model picks the source_ids that genuinely matter to the query (collapse
 * near-duplicates, drop tangential records), giving each a short label.
 */
import type { PipelineSchema } from '../types';

export const mindmapNodesSchema: PipelineSchema = {
  name: 'mindmap_nodes',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source_id: { type: 'string', description: 'uniqueid from the evidence' },
            label: { type: 'string', description: '2–6 word node title' },
            summary: { type: 'string', description: 'one sentence: what it contributes' },
          },
          required: ['source_id'],
        },
      },
    },
    required: ['nodes'],
  },
};
