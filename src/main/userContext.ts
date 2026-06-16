/**
 * User context (main process).
 *
 * Holds the two facts the user gave during onboarding — their role/work-type
 * and a free-text persona — so the local AI surfaces (local-model & CLI chat in
 * providers/runner, and the knowledge-graph engine in file-graph/llm) can
 * prepend a short "here is who the user is, tailor your answers" preamble to
 * their system prompts.
 *
 * The renderer owns the source values (localStorage) and mirrors them here via
 * the `user-context:set` IPC; we persist to electron-store and keep an
 * in-memory cache so the prompt builders (which are synchronous) can read it
 * without awaiting. `hydrate()` loads the cache from the store on boot.
 */
import { getStoreValue, setStoreValue } from './utils/storage/store';

const STORE_KEY_WORK = 'userContext.workTypeLabel';
const STORE_KEY_PERSONA = 'userContext.persona';

export interface UserContext {
  workTypeLabel: string;
  persona: string;
}

// Synchronous cache the prompt builders read. Populated by hydrate() on boot
// and kept fresh by setUserContext() on every onboarding mirror.
let cache: UserContext = { workTypeLabel: '', persona: '' };

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Load the persisted context into the cache once at startup.
export async function hydrateUserContext(): Promise<void> {
  try {
    const [workTypeLabel, persona] = await Promise.all([
      getStoreValue(STORE_KEY_WORK, ''),
      getStoreValue(STORE_KEY_PERSONA, ''),
    ]);
    cache = { workTypeLabel: clean(workTypeLabel), persona: clean(persona) };
  } catch {
    /* keep the empty cache — preamble just stays blank */
  }
}

// Update both the cache (sync reads) and the persisted store (next boot).
export function setUserContext(input: Partial<UserContext>): void {
  cache = {
    workTypeLabel: clean(input.workTypeLabel),
    persona: clean(input.persona),
  };
  // Fire-and-forget persistence; the cache is already authoritative this run.
  setStoreValue(STORE_KEY_WORK, cache.workTypeLabel).catch(() => undefined);
  setStoreValue(STORE_KEY_PERSONA, cache.persona).catch(() => undefined);
}

/**
 * The system-prompt preamble built from the cached context, or '' when nothing
 * was collected. Kept verbatim-aligned with the backend's cloud-Stella version
 * (ai/stella_v2/prompts.py) so every surface speaks about the user the same way.
 */
export function getUserContextPreamble(): string {
  const { workTypeLabel, persona } = cache;
  if (!workTypeLabel && !persona) return '';
  const parts: string[] = [
    'Here is some context about the user you are helping.',
  ];
  if (workTypeLabel) parts.push(`Their work / role: "${workTypeLabel}".`);
  if (persona)
    parts.push(`In their own words, about them and their goals: "${persona}".`);
  parts.push('Use this to personalize and tailor your responses to them.');
  return parts.join(' ');
}
