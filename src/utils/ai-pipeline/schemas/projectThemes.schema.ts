/**
 * projectThemes — structured-output contract for the `initialProjectGenerate`
 * task (the home recall UI). Mirrors the backend /initial-project-generate
 * `themes` shape so local/CLI synthesis renders in the same Result panel the
 * cloud path already feeds.
 */
import type { PipelineSchema } from '../types';

export const projectThemesSchema: PipelineSchema = {
  name: 'project_themes',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      themes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            open: {
              type: 'boolean',
              description: 'true for the trailing "open threads to explore" theme.',
            },
            bullets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: { type: 'string' },
                  source_ids: { type: 'array', items: { type: 'string' } },
                },
                required: ['text'],
              },
            },
          },
          required: ['title', 'bullets'],
        },
      },
    },
    required: ['themes'],
  },
};

export interface ProjectThemeBullet {
  text: string;
  source_ids?: string[];
}
export interface ProjectTheme {
  title: string;
  open?: boolean;
  bullets: ProjectThemeBullet[];
}
export interface ProjectThemes {
  themes: ProjectTheme[];
  // Cloud endpoint also returns these; local/CLI may omit them.
  projectName?: string;
  projectEmoji?: string;
  sourcesSummary?: string;
  attachedSources?: unknown[];
}
