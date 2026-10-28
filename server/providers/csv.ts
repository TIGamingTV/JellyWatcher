import { parse } from 'csv-parse/sync';

/** Parses CSV text into rows of strings. Tolerates BOMs, CRLF and ragged rows. */
export function parseCsvRows(text: string): string[][] {
  return parse(text.replace(/^\uFEFF/, ''), {
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    trim: true,
  }) as string[][];
}

export function headerIndex(header: string[], aliases: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  for (const a of aliases) {
    const i = norm.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

export function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function toFloat(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Decodes an uploaded text file as UTF-8, falling back to latin1 if it is not valid UTF-8. */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('latin1').decode(buf);
  }
}
