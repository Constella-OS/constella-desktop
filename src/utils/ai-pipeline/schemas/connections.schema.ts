/**
 * connections — edge-classification contract for the local/CLI mindmap path.
 * The model lists only the SIGNIFICANT connections between selected nodes:
 * typed, strength-scored, with a substantive caption. The step drops type:none
 * and below-floor edges, and skips pairs that are already connected — so only
 * meaningful, new edges survive. Mirrors the backend classify_connections shape.
 */
import type { PipelineSchema } from '../types';

export const connectionsSchema: PipelineSchema = {
  name: 'connections',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      connections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source_id: { type: 'string' },
            target_id: { type: 'string' },
            type: {
              type: 'string',
              enum: [
                'similar',
                'contradicts',
                'supports',
                'extends',
                'insight',
                'references',
                'none',
              ],
            },
            strength: { type: 'number', description: '0.0–1.0' },
            context: {
              type: 'string',
              description: 'substantive caption of the relationship (not graph mechanics)',
            },
          },
          required: ['source_id', 'target_id', 'type'],
        },
      },
    },
    required: ['connections'],
  },
};
