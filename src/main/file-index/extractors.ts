/**
 * File-index extractors — turn an on-disk file into plain text we can chunk +
 * embed. Plain `.md`/`.txt` are read straight off disk; binary documents
 * (PDF / Word / Excel) are run through the same parsers the existing
 * `embed-file` handler uses (pdf-parse, mammoth, word-extractor) plus `xlsx`
 * for spreadsheets.
 *
 * This is the de-qmd'd replacement for agents-slack's extractors.ts +
 * extractedMirror.ts: we don't keep a separate "__extracted" mirror collection,
 * the extracted text feeds chunking directly (see chunker.ts + records.ts).
 */
import fs from 'fs/promises';
import path from 'path';

// pdf-parse's index does a debug self-test on require in some builds; import the
// lib entry directly (same trick file-embedding-handler.ts uses).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdf = require('pdf-parse/lib/pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require('mammoth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WordExtractor = require('word-extractor');

const wordExtractor = new WordExtractor();

/** Text files we read directly (no parsing). Lower-case, with leading dot. */
export const TEXT_EXTENSIONS = ['.md', '.txt', '.markdown'];

/** Binary documents we extract to text via a parser. */
export const EXTRACTABLE_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
];

/** Everything the indexer is willing to read from a folder. */
export const INDEXABLE_EXTENSIONS = [
  ...TEXT_EXTENSIONS,
  ...EXTRACTABLE_EXTENSIONS,
];

export type ExtractKind = 'text' | 'pdf' | 'word' | 'spreadsheet';

export type ExtractOutcome =
  | { ok: true; kind: ExtractKind; text: string; chars: number }
  | { ok: false; reason: 'unsupported' | 'empty' | 'error'; message?: string };

/** True when this path is one the indexer knows how to read. */
export function isIndexableFile(absPath: string): boolean {
  return INDEXABLE_EXTENSIONS.includes(path.extname(absPath).toLowerCase());
}

/** Map a file extension to the NoteType the rest of the app uses for the
 *  card icon / type badge. Mirrors cloud-search's detectFileType buckets. */
export function noteTypeForExtension(absPath: string): 'pdf' | 'text' {
  const ext = path.extname(absPath).toLowerCase();
  // PDFs and Office docs all render as the "document" type on a card.
  return EXTRACTABLE_EXTENSIONS.includes(ext) ? 'pdf' : 'text';
}

/**
 * Read + extract one file to plain text. Never throws — returns a tagged
 * outcome so the indexer can record a per-file failure and keep going.
 */
export async function extractToText(absPath: string): Promise<ExtractOutcome> {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = await fs.readFile(absPath, 'utf8');
      return finish('text', text);
    }
    if (ext === '.pdf') {
      const buf = await fs.readFile(absPath);
      const data = await pdf(buf, {});
      return finish('pdf', data?.text ?? '');
    }
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: absPath });
      return finish('word', result?.value ?? '');
    }
    if (ext === '.doc') {
      const doc = await wordExtractor.extract(absPath);
      let text = '';
      try {
        text = doc.getBody() ?? '';
      } catch {
        /* fall through to headers/textboxes */
      }
      if (!text) {
        try {
          text += doc.getHeaders() ?? '';
        } catch {
          /* ignore */
        }
        try {
          text += doc.getTextboxes() ?? '';
        } catch {
          /* ignore */
        }
      }
      return finish('word', text);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      return finish('spreadsheet', await extractSpreadsheet(absPath));
    }
    return { ok: false, reason: 'unsupported' };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message || String(e) };
  }
}

/** Convert every sheet of a workbook into CSV blocks, concatenated with a
 *  `## <sheet name>` heading so chunk text stays readable. */
async function extractSpreadsheet(absPath: string): Promise<string> {
  // Lazy require — keeps the (pure-JS but chunky) xlsx lib out of the module
  // graph until a spreadsheet is actually indexed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(absPath, { cellFormula: false, cellHTML: false });
  const parts: string[] = [];
  for (const name of wb.SheetNames as string[]) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv: string = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    parts.push(`## ${name}\n${csv.trim()}`);
  }
  return parts.join('\n\n');
}

/** Normalise + length-check extracted text into a final outcome. Collapses
 *  runs of spaces/tabs (PDF extraction is noisy) but preserves newlines so the
 *  chunker can still group by line. */
function finish(kind: ExtractKind, raw: string): ExtractOutcome {
  const text = (raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!text) return { ok: false, reason: 'empty' };
  return { ok: true, kind, text, chars: text.length };
}
