/** Small helpers for reading public web pages (Letterboxd lists, MDBList titles). No DOM needed. */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

export function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

/** Value of an attribute inside one tag ('…' or "…" quoted). */
export function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeHtml(m[1] ?? m[2] ?? '') : null;
}

/** content of <meta property="og:…"> (or name="…"). */
export function metaContent(html: string, property: string): string | null {
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    if (attr(tag, 'property') === property || attr(tag, 'name') === property) return attr(tag, 'content');
  }
  return null;
}
