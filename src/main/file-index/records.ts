/**
 * Record builder — turns one extracted+chunked+embedded file into the exact
 * record shapes the rest of the app already understands:
 *   - a parent `NoteRxdbData`-shaped object (db.notes + a LanceDB 'note' row)
 *   - N `NoteBodyRxdbData`-shaped chunk objects (db.noteBodies + LanceDB
 *     'note_body' rows)
 *
 * IDs are deterministic (uuid v5 of the file path / parent+index) so that
 * re-indexing a changed file UPSERTS the same note + chunks in place instead of
 * piling up duplicates. IDs are clean uuids with no `__` — note-logic's
 * `parseVectorDBSearchResults` dedups on `uniqueid.split('__')[0]`, so a `__`
 * in a chunk id would collapse every chunk of a file into one.
 *
 * LanceDB chunk rows follow note-logic's hydration convention:
 *   relatedIds[1] === the chunk's own NoteBody id (looked up in db.noteBodies);
 *   the parent is then resolved via NoteBodyRxdbData.referenceId.
 */
import path from 'path';
import { v5 as uuidv5 } from 'uuid';
import type { IndexedSource } from './sources';
import type { Chunk } from './chunker';
import { noteTypeForExtension } from './extractors';

// Fixed namespace so ids are stable across runs/machines for the same path.
const FILE_INDEX_NAMESPACE = '8f4a1d2e-7c63-4b9a-9f0e-1a2b3c4d5e6f';

// Tag colors reused for per-source category pills (cycled by source order is
// overkill — one stable color per source id is enough + deterministic).
const SOURCE_TAG_COLORS = [
  '#7C9CF5',
  '#F5A97C',
  '#9CE89C',
  '#E89CD8',
  '#E8D89C',
  '#9CD8E8',
];

export interface LanceRow {
  uniqueid: string;
  vector: number[];
  nodeType: 'note' | 'note_body';
  deleted: boolean;
  relatedIds: string[];
}

export interface BuiltFileRecords {
  parentId: string;
  /** Plain object matching NoteRxdbData.toObject() — renderer parses + writes. */
  note: Record<string, any>;
  /** Plain objects matching NoteBodyRxdbData.toObject(). */
  noteBodies: Record<string, any>[];
  /** Rows to upsert into LanceDB (parent + every chunk). */
  lanceRows: LanceRow[];
}

/** Deterministic parent-note id for a file path. */
export function parentIdForPath(absPath: string): string {
  return uuidv5(`file:${absPath}`, FILE_INDEX_NAMESPACE);
}

/** Deterministic chunk id for a (parent, chunkIndex). */
export function chunkId(parentId: string, index: number): string {
  return uuidv5(`chunk:${parentId}:${index}`, FILE_INDEX_NAMESPACE);
}

/** Deterministic per-source category tag (so indexed files are filterable). */
export function sourceTag(source: IndexedSource): {
  uniqueid: string;
  name: string;
  color: string;
} {
  const id = uuidv5(`file-index-tag:${source.id}`, FILE_INDEX_NAMESPACE);
  // Stable color pick from the id's first hex digits.
  const idx = parseInt(id.replace(/[^0-9a-f]/g, '').slice(0, 4), 16);
  return {
    uniqueid: id,
    name: source.name,
    color: SOURCE_TAG_COLORS[idx % SOURCE_TAG_COLORS.length],
  };
}

/** integrationName/subtype drive the card logo + type. Obsidian sources reuse
 *  the real Obsidian integration; everything else is the generic 'local' file. */
function integrationFor(source: IndexedSource): {
  integrationName: string;
  subtype: string;
} {
  if (source.kind === 'obsidian') {
    return { integrationName: 'obsidian', subtype: 'obsidian_note' };
  }
  return { integrationName: 'local', subtype: 'local_file' };
}

export interface BuildInput {
  source: IndexedSource;
  absPath: string;
  mtimeMs: number;
  text: string; // full extracted text
  parentVector: number[];
  chunks: Chunk[];
  chunkVectors: number[][]; // aligned 1:1 with chunks
}

/**
 * Assemble all records for one file. The caller has already extracted text,
 * chunked it, and produced the parent + chunk vectors.
 */
export function buildFileRecords(input: BuildInput): BuiltFileRecords {
  const { source, absPath, mtimeMs, text, parentVector, chunks, chunkVectors } =
    input;

  const parentId = parentIdForPath(absPath);
  const fileName = path.basename(absPath);
  const title = fileName.replace(/\.[^.]+$/, '') || fileName;
  const noteType = noteTypeForExtension(absPath);
  const isDoc = noteType === 'pdf';
  const { integrationName, subtype } = integrationFor(source);
  const tag = sourceTag(source);
  const created = mtimeMs || Date.now();

  // Mirror the existing doc-note convention: PDFs/Office docs keep their text
  // in `fileText` (content stays empty); plain text/markdown lives in content.
  const note: Record<string, any> = {
    uniqueid: parentId,
    title,
    content: isDoc ? '' : text,
    vector: parentVector,
    filePath: absPath,
    tags: [tag],
    created,
    lastModified: created,
    incomingConnections: [],
    outgoingConnections: [],
    incomingConnectionsV2: [],
    outgoingConnectionsV2: [],
    noteType,
    fileText: isDoc ? text : '',
    fileName,
    fileSummary: '',
    integrationName,
    subtype,
  };

  const noteBodies: Record<string, any>[] = [];
  const lanceRows: LanceRow[] = [
    {
      uniqueid: parentId,
      vector: parentVector,
      nodeType: 'note',
      deleted: false,
      relatedIds: [],
    },
  ];

  chunks.forEach((chunk, i) => {
    const vec = chunkVectors[i];
    if (!vec || !vec.length) return; // embedding failed for this chunk — skip
    const cid = chunkId(parentId, chunk.index);
    noteBodies.push({
      uniqueid: cid,
      text: chunk.text,
      vector: vec,
      referenceId: parentId,
      type: 'note',
      created,
      lastModified: created,
      position: chunk.index,
      referenceTitle: title,
      outgoingConnections: [],
      incomingConnectionsV2: [],
      outgoingConnectionsV2: [],
    });
    lanceRows.push({
      uniqueid: cid,
      vector: vec,
      nodeType: 'note_body',
      deleted: false,
      // relatedIds[1] === chunk's own NoteBody id (note-logic hydration looks
      // it up in db.noteBodies); relatedIds[0] carries the parent for debugging.
      relatedIds: [parentId, cid],
    });
  });

  return { parentId, note, noteBodies, lanceRows };
}
