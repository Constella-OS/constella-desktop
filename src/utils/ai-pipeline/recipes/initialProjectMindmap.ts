/**
 * TASK: initialProjectMindmap — query → relevant nodes → SIGNIFICANT new
 * connections → {nodes, edges} for the canvas.
 *
 * The provider-aware, query-driven version of the mindmap generation:
 *   retrieve (relevant nodes, local+cloud hydrated) → buildMindmap (node-select +
 *   classify-connections: significant only, skip existing).
 *
 * cloud delegates to /initial-project-generate (mode:'mindmap'); local/CLI run
 * node-select + connection-classification on-device. Output feeds the canvas:
 * use `layoutMindmapNodes` to assign radial positions.
 *
 * Input:  string (the user query) — also set on ctx.query by the entry point.
 * Output: MindmapResult { nodes (RelevantNote[]), edges, projectName?, sourcesSummary? }.
 */
import { recipe } from '../runner';
import { retrieve } from './retrieve';
import { buildMindmap } from '../steps/buildMindmap';
import type { MindmapResult, Step } from '../types';

export const initialProjectMindmap: Step<string, MindmapResult> = recipe<
  string,
  MindmapResult
>([
  retrieve as Step<unknown, unknown>,
  buildMindmap as Step<unknown, unknown>,
]);

// ---- canvas layout -------------------------------------------------------

// Radial polar layout, mirroring MindmapStreamConductor's placement so the
// pipeline-built canvas looks like the streamed one (rings of 6).
const RADIAL_BASE_RADIUS = 700;
const RADIAL_RING_STEP = 380;
const RADIAL_NODES_PER_RING = 6;

/** Deterministic radial position for the i-th node (no RNG — resume-safe). */
export function polarPositionForIndex(i: number): { x: number; y: number } {
  const ring = Math.floor(i / RADIAL_NODES_PER_RING);
  const k = i % RADIAL_NODES_PER_RING;
  const radius = RADIAL_BASE_RADIUS + ring * RADIAL_RING_STEP;
  const angle =
    (k / RADIAL_NODES_PER_RING) * 2 * Math.PI +
    ring * (Math.PI / RADIAL_NODES_PER_RING);
  return {
    x: Math.round(radius * Math.cos(angle)),
    y: Math.round(radius * Math.sin(angle)),
  };
}

/** Pair each node record with a radial canvas position (placement order = input). */
export function layoutMindmapNodes(
  nodes: unknown[],
): Array<{ note: unknown; position: { x: number; y: number } }> {
  return nodes.map((note, i) => ({ note, position: polarPositionForIndex(i) }));
}
