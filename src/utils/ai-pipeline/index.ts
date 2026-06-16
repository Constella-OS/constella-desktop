/**
 * AI Pipeline — public surface. See ./README.md for the full design.
 *
 * Import from here (not deep paths) when wiring a UI entry point:
 *   import { runRecipe, buildStepCtx, aiChat } from 'utils/ai-pipeline';
 */
export * from './types';
export { recipe, fanOut, parallel, runRecipe } from './runner';
export { buildStepCtx } from './ctx';

// Recipes
export { retrieve } from './recipes/retrieve';
export { aiSearch } from './recipes/aiSearch';
export { initialProjectGenerate } from './recipes/initialProjectGenerate';
export {
  initialProjectMindmap,
  layoutMindmapNodes,
  polarPositionForIndex,
} from './recipes/initialProjectMindmap';
export { aiChat } from './recipes/aiChat';
export { homeDiscoverySplit } from './recipes/homeDiscoverySplit';

// AI Node operations (search / synthesize / custom-prompt) — return the exact
// AISearchResult / AISynthesizeResult shapes the AINode UI consumes.
export {
  aiNodeSearch,
  aiNodeSynthesize,
  aiNodeCustomPrompt,
  type AiNodeSynthesizeArgs,
  type AiNodeCustomPromptArgs,
} from './aiNode';

// Schemas
export { recallInsightsSchema } from './schemas/recallInsights.schema';
export type { RecallInsights } from './schemas/recallInsights.schema';
export { projectThemesSchema } from './schemas/projectThemes.schema';
export type {
  ProjectThemes,
  ProjectTheme,
  ProjectThemeBullet,
} from './schemas/projectThemes.schema';

// Binding utilities (exported for reuse + testing)
export { extractJsonObject, parseJsonObject } from './binding/jsonExtract';
export { buildStructuredPrompt } from './binding/structuredPrompt';
