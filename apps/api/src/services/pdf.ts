/**
 * Minimal, dependency-free text PDF writer (spec P8/P10 private PDF exports). Workers-compatible: no
 * Node APIs, no eval, no fonts to embed (standard Helvetica with WinAnsiEncoding). It emits only
 * text: no JavaScript, actions, links, annotations, forms or embedded files. Strings are escaped
 * (backslash, parentheses) and non-ASCII characters are written as octal escapes or replaced, so
 * untrusted text can never break out of a string object.
 */

export type PdfBlock =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string; readonly indent?: number }
  | { readonly kind: 'spacer' };

export interface PdfDocument {
  /** Generic document title (never a child's name). */
  readonly title: string;
  readonly blocks: readonly PdfBlock[];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const STYLES = {
  title: { font: 'F2', size: 16, leading: 22 },
  heading: { font: 'F2', size: 12.5, leading: 18 },
  paragraph: { font: 'F1', size: 11, leading: 14.5 },
} as const;
/** Conservative average Helvetica glyph width (em fraction) for line wrapping. */
const AVERAGE_WIDTH = 0.56;
export const MAX_PDF_PAGES = 200;

/** WinAnsiEncoding code points for typographic characters outside Latin-1. */
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '…': 0x85,
};
const REPLACEMENTS: Readonly<Record<string, string>> = { '−': '-', ' ': ' ' };

/** Normalizes untrusted text to characters the standard font can show. */
export function toWinAnsiText(text: string): string {
  let out = '';
  for (const raw of text.normalize('NFC')) {
    const ch = REPLACEMENTS[raw] ?? raw;
    const code = ch.codePointAt(0) ?? 0x3f;
    if (ch === '\n' || ch === '\t') out += ' ';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue;
    else if (code <= 0xff || WIN_ANSI_EXTRA[ch] !== undefined) out += ch;
    else out += '?';
  }
  return out;
}

/** A PDF literal string body: escapes `\`, `(`, `)` and writes non-ASCII bytes as octal. */
export function escapePdfString(text: string): string {
  let out = '';
  for (const ch of toWinAnsiText(text)) {
    if (ch === '\\' || ch === '(' || ch === ')') {
      out += `\\${ch}`;
      continue;
    }
    const code = WIN_ANSI_EXTRA[ch] ?? ch.codePointAt(0) ?? 0x3f;
    out += code >= 0x20 && code < 0x7f ? ch : `\\${code.toString(8).padStart(3, '0')}`;
  }
  return out;
}

function wrap(text: string, maxChars: number): string[] {
  const words = toWinAnsiText(text)
    .split(/ +/)
    .filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (let word of words) {
    while (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

interface Line {
  readonly font: string;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

function layout(doc: PdfDocument): Line[][] {
  const pages: Line[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  const newPage = () => {
    if (pages.length >= MAX_PDF_PAGES) throw new Error('PDF_TOO_LONG');
    pages.push([]);
    y = PAGE_HEIGHT - MARGIN;
  };
  for (const block of doc.blocks) {
    if (block.kind === 'spacer') {
      y -= 8;
      continue;
    }
    const style = STYLES[block.kind];
    const indent =
      block.kind === 'paragraph' ? Math.max(0, Math.min(4, block.indent ?? 0)) * 18 : 0;
    const width = PAGE_WIDTH - 2 * MARGIN - indent;
    const maxChars = Math.max(10, Math.floor(width / (style.size * AVERAGE_WIDTH)));
    if (block.kind !== 'paragraph') y -= 4;
    for (const text of wrap(block.text, maxChars)) {
      if (y - style.leading < MARGIN) newPage();
      y -= style.leading;
      pages[pages.length - 1]!.push({
        font: style.font,
        size: style.size,
        x: MARGIN + indent,
        y,
        text,
      });
    }
  }
  return pages;
}

/** Renders a text-only PDF 1.4 document. */
export function renderTextPdf(doc: PdfDocument): Uint8Array {
  const pages = layout(doc);
  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info, then (page, content) pairs.
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = `<< /Title (${escapePdfString(doc.title)}) /Producer (PencilLift) >>`;
  pages.forEach((lines, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    const stream = lines
      .map(
        (l) =>
          `BT /${l.font} ${l.size} Tf ${l.x.toFixed(2)} ${l.y.toFixed(2)} Td (${escapePdfString(l.text)}) Tj ET`,
      )
      .join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  // Every character above is ASCII (escapes cover the rest), so string length = byte length.
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
