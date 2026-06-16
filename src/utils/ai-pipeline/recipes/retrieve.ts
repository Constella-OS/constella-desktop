/**
 * FRAGMENT: retrieve — query → evidence.
 *
 * The one mode-aware composition. generateQueries runs once on the provider;
 * localSearch + cloudSearch run concurrently (each self-gates on ctx.mode);
 * dedupByUniqueId merges them into a single evidence list (cloud wins on
 * conflict, local-only appended). Every task (recall, future initial-project,
 * chat) reuses this, so they all inherit local / cloud / hybrid for free.
 *
 * Input:  string (the user query)
 * Output: EvidenceItem[]
 */
import { recipe, fanOut } from '../runner';
import { generateQueries } from '../steps/generateQueries';
import { localSearch } from '../steps/localSearch';
import { cloudSearch } from '../steps/cloudSearch';
import { dedupByUniqueId } from '../steps/dedupByUniqueId';
import type { EvidenceItem, Step } from '../types';

export const retrieve: Step<string, EvidenceItem[]> = recipe<
  string,
  EvidenceItem[]
>([
  generateQueries as Step<unknown, unknown>,
  fanOut([localSearch, cloudSearch]) as Step<unknown, unknown>,
  dedupByUniqueId as Step<unknown, unknown>,
]);
