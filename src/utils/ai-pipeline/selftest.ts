/**
 * AI Pipeline self-test — a smoke test that runs once on app open (dev) to prove
 * the engine + pure building blocks are wired correctly, and (best-effort) that a
 * live `retrieve` reaches the configured data sources.
 *
 * Two tiers:
 *   1. DETERMINISTIC (no network / no model): engine composition (recipe / fanOut
 *      / nesting), the balanced-brace JSON extractor, and the dedup merge. These
 *      must always pass — a failure here means the core is broken.
 *   2. LIVE (best-effort, never fatal): runs the real `retrieve` recipe and logs
 *      how many local vs cloud evidence items came back. Skipped if logged out.
 *
 * Everything is wrapped so the test never throws into app startup. Results are
 * logged under the [ai-pipeline self-test] prefix with a final PASS/FAIL summary.
 */
import { recipe, fanOut, runRecipe } from './runner';
import { buildStepCtx } from './ctx';
import { extractJsonObject, parseJsonObject } from './binding/jsonExtract';
import { dedupByUniqueId } from './steps/dedupByUniqueId';
import { retrieve } from './recipes/retrieve';
import type { EvidenceItem, Step, StepCtx } from './types';

const TAG = '[ai-pipeline self-test]';

interface Results {
  passed: number;
  failed: number;
  total: number;
}

/** Tiny recorder: log + tally each assertion without throwing. */
function makeRecorder() {
  const r: Results = { passed: 0, failed: 0, total: 0 };
  const check = (name: string, cond: boolean, detail?: unknown) => {
    r.total += 1;
    if (cond) {
      r.passed += 1;
      console.log(`${TAG} ✓ ${name}`);
    } else {
      r.failed += 1;
      console.error(`${TAG} ✗ ${name}`, detail ?? '');
    }
  };
  return { r, check };
}

// ---- Tier 1: engine composition ------------------------------------------

async function testEngine(check: (n: string, c: boolean, d?: unknown) => void) {
  const ctx = buildStepCtx({ mode: 'local', provider: 'cloud' });
  const addOne: Step<number, number> = async (n) => n + 1;
  const double: Step<number, number> = async (n) => n * 2;

  // recipe threads output → input: (3+1)*2 = 8
  const seq = recipe<number, number>([
    addOne as Step<unknown, unknown>,
    double as Step<unknown, unknown>,
  ]);
  check('recipe threads sequentially', (await runRecipe(seq, 3, ctx)) === 8);

  // fanOut runs both on the same input → [4, 6]
  const fan = fanOut<number, number>([addOne, double]);
  const fanRes = await fan(3, ctx);
  check('fanOut runs on same input', fanRes[0] === 4 && fanRes[1] === 6, fanRes);

  // nesting: a recipe used as a step inside another recipe → (3+1)*2 = 8
  const nested = recipe<number, number>([
    recipe<number, number>([addOne as Step<unknown, unknown>]) as Step<unknown, unknown>,
    double as Step<unknown, unknown>,
  ]);
  check('recipes nest (fractal)', (await runRecipe(nested, 3, ctx)) === 8);
}

// ---- Tier 1: JSON brace extractor (CLI binding) --------------------------

function testJsonExtract(check: (n: string, c: boolean, d?: unknown) => void) {
  const cases: Array<[string, string, unknown]> = [
    ['plain with prose', 'here it is: {"a":1} thanks', { a: 1 }],
    ['braces inside string', '{"s":"a}{b"}', { s: 'a}{b' }],
    ['escaped quote in string', '{"s":"he said \\"hi\\" }"}', { s: 'he said "hi" }' }],
    ['markdown fenced', '```json\n{"a":[1,2]}\n```', { a: [1, 2] }],
    ['nested object', '{"a":{"b":2},"c":3}', { a: { b: 2 }, c: 3 }],
    ['leading thinking', 'Let me think...\n{"x":true}\nDone.', { x: true }],
  ];
  for (const [name, input, expected] of cases) {
    const parsed = parseJsonObject(input);
    check(
      `jsonExtract: ${name}`,
      JSON.stringify(parsed) === JSON.stringify(expected),
      { parsed, expected },
    );
  }
  // No object → null
  check('jsonExtract: no object → null', extractJsonObject('no json here') === null);
  // Unbalanced → null
  check('jsonExtract: unbalanced → null', extractJsonObject('{"a":1') === null);
}

// ---- Tier 1: dedup merge contract ----------------------------------------

async function testDedup(check: (n: string, c: boolean, d?: unknown) => void) {
  const ctx = buildStepCtx({ mode: 'hybrid', provider: 'cloud' });
  const local: EvidenceItem[] = [
    { uniqueid: 'shared', title: 'local copy', origin: 'local' },
    { uniqueid: 'local-only', title: 'indexed file', origin: 'local' },
  ];
  const cloud: EvidenceItem[] = [
    { uniqueid: 'shared', title: 'cloud copy', origin: 'cloud' },
    { uniqueid: 'cloud-only', title: 'notion page', origin: 'cloud' },
  ];
  const merged = await dedupByUniqueId([local, cloud], ctx);
  const byId = new Map(merged.map((m) => [m.uniqueid, m]));

  check('dedup: total unique = 3', merged.length === 3, merged.length);
  check(
    'dedup: cloud wins on conflict',
    byId.get('shared')?.title === 'cloud copy',
    byId.get('shared'),
  );
  check('dedup: local-only appended', byId.has('local-only'));
  check('dedup: cloud-only kept', byId.has('cloud-only'));
}

// ---- Tier 2: live retrieve (best-effort) ---------------------------------

async function testLiveRetrieve(
  check: (n: string, c: boolean, d?: unknown) => void,
) {
  const ctx: StepCtx = buildStepCtx({
    mode: 'hybrid',
    provider: 'cloud',
    query: 'test',
    topK: 5,
  });
  if (!ctx.userId) {
    console.log(`${TAG} (live retrieve skipped — not logged in)`);
    return;
  }
  try {
    const evidence = await runRecipe(retrieve, 'test', ctx);
    const localN = evidence.filter((e) => e.origin === 'local').length;
    const cloudN = evidence.filter((e) => e.origin === 'cloud').length;
    console.log(
      `${TAG} live retrieve('test'): ${evidence.length} items (local=${localN}, cloud=${cloudN})`,
    );
    check('live retrieve returned an array', Array.isArray(evidence));
  } catch (e: any) {
    console.warn(`${TAG} live retrieve errored (non-fatal):`, e?.message || e);
  }
}

/** Run the full self-test. Never throws; returns the tally. */
export async function runAiPipelineSelfTest(): Promise<Results> {
  console.log(`${TAG} starting…`);
  const { r, check } = makeRecorder();
  try {
    await testEngine(check);
    testJsonExtract(check);
    await testDedup(check);
    await testLiveRetrieve(check);
  } catch (e: any) {
    console.error(`${TAG} unexpected error:`, e?.message || e);
  }
  const verdict = r.failed === 0 ? 'PASS' : 'FAIL';
  console.log(
    `${TAG} ${verdict} — ${r.passed}/${r.total} checks passed` +
      (r.failed ? `, ${r.failed} failed` : ''),
  );
  return r;
}
