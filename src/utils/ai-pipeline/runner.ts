/**
 * AI Pipeline — the engine.
 *
 * Three primitives, all PURE:
 *   - recipe(steps)  : compose steps into a single Step (a recipe IS a step, so
 *                      recipes nest — this is the fractal property from the README).
 *   - fanOut(steps)  : run several steps on the SAME input concurrently, collect
 *                      their outputs into an array (used by `retrieve` to run
 *                      local + cloud search at once; each search self-gates on mode).
 *   - runRecipe(...)  : entry point that executes a top-level recipe.
 *
 * The runner threads each step's output into the next and never inspects what a
 * step does — a step might be a model call, a search, or a pure transform.
 */
import type { Step, StepCtx } from './types';

/**
 * Compose steps into one Step. Runs them in order, feeding each output into the
 * next; returns the final step's output. Because the result is itself a Step,
 * `recipe([...])` is usable anywhere a step is (recall uses `retrieve` this way).
 */
export function recipe<In = unknown, Out = unknown>(
  steps: Step<unknown, unknown>[],
): Step<In, Out> {
  return async (input: In, ctx: StepCtx): Promise<Out> => {
    let data: unknown = input;
    for (const step of steps) {
      // Stop advancing if a newer run superseded this one (e.g. the user started
      // a new canvas mid-run) — keeps a stale recipe from emitting into the new
      // chat via the global applyNormalizedToChat sink.
      if (ctx.signal?.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      data = await step(data, ctx);
    }
    return data as Out;
  };
}

/**
 * Run several steps on the SAME input concurrently and return their outputs as
 * an array (order preserved). Used inside `retrieve`: fanOut([localSearch,
 * cloudSearch]) → [localResults, cloudResults]. Each search self-gates on
 * ctx.mode, so in local mode cloudSearch returns [] and vice-versa.
 */
export function fanOut<In, Out>(steps: Step<In, Out>[]): Step<In, Out[]> {
  return async (input: In, ctx: StepCtx): Promise<Out[]> =>
    Promise.all(steps.map((s) => s(input, ctx)));
}

/**
 * Ad-hoc concurrency for a stage that needs to run thunks in parallel (e.g. a
 * future per-item synthesis fan). Mirrors Promise.all but reads intentionally at
 * call sites. A thunk that rejects rejects the whole call — wrap if you need
 * partial tolerance.
 */
export function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(thunks.map((t) => t()));
}

/** Execute a top-level recipe. Nested recipes run automatically as sub-steps. */
export function runRecipe<In, Out>(
  r: Step<In, Out>,
  input: In,
  ctx: StepCtx,
): Promise<Out> {
  return r(input, ctx);
}
