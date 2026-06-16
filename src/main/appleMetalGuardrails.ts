/**
 * Apple Silicon Metal guardrails.
 *
 * Backport of qmd PR #600 (luoyuctl), the same fix used in the agents-slack
 * project. macOS arm64 + node-llama-cpp (libggml's Metal backend) has two
 * known bad interactions on recent Apple Silicon + macOS (notably macOS 26.x /
 * M5+ chips):
 *
 *   1. Metal residency sets cause assertion failures in libggml
 *      (`GGML_ASSERT([rsets->data count] == 0)`), crashing the process when a
 *      model is loaded / a context is created.
 *      → mitigation: GGML_METAL_NO_RESIDENCY=1  (all darwin/arm64)
 *   2. The Metal tensor probe crashes Metal shader compilation on
 *      M5/A19/A20-class chips, after which libggml falls back to source
 *      compilation which then also fails.
 *      → mitigation: GGML_METAL_TENSOR_DISABLE=1 (only on that chip class)
 *
 * These env vars are read by ggml at native-init time, so they MUST be set
 * before node-llama-cpp first loads its native binary. In this app every
 * `getLlama()` call is lazy (dynamic `import("node-llama-cpp")` inside a
 * method), so applying these at the very top of `main.ts` — and injecting them
 * into the local-llm utilityProcess env — guarantees they are in place before
 * any model load in any process.
 *
 * Opt-out: set CONSTELLA_APPLE_METAL_WORKAROUNDS=off.
 */
import os from 'os';

/** First CPU's brand string, e.g. "Apple M5" / "Apple M5 Pro". Empty on failure. */
function chipBrandString(): string {
  try {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return '';
    return String(cpus[0]?.model ?? '');
  } catch {
    return '';
  }
}

/**
 * Pure: returns the env patches that should be applied for the current machine.
 * No side effects, so it's safe to unit-test and to call from multiple places
 * (main process + worker env construction). Returns {} on any non-macOS-arm64
 * machine or when the workarounds are opted out.
 */
export function getAppleMetalWorkaroundEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if ((env.CONSTELLA_APPLE_METAL_WORKAROUNDS ?? '').toLowerCase() === 'off') {
    return {};
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return {};
  }

  const patch: Record<string, string> = {};

  // Residency-set workaround applies to ALL darwin/arm64.
  if (env.GGML_METAL_NO_RESIDENCY == null) {
    patch.GGML_METAL_NO_RESIDENCY = '1';
  }

  // Tensor-probe disable only on M5/A19/A20-class chips. The CPU brand string
  // on Apple Silicon looks like "Apple M5" / "Apple M5 Pro" / "Apple A19".
  const brand = chipBrandString();
  if (
    /(?:Apple\s+)?(M5|M6|M7|A19|A20|A21)\b/i.test(brand) &&
    env.GGML_METAL_TENSOR_DISABLE == null
  ) {
    patch.GGML_METAL_TENSOR_DISABLE = '1';
  }

  return patch;
}

/**
 * Apply the patches to `process.env` (main process). Returns the `KEY=value`
 * strings that were set so the caller can log them. Idempotent — re-running
 * after the vars exist is a no-op.
 */
export function applyAppleMetalWorkaroundEnv(): string[] {
  const patch = getAppleMetalWorkaroundEnv();
  const applied: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    process.env[key] = value;
    applied.push(`${key}=${value}`);
  }
  return applied;
}
