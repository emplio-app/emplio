// A document's words, and Markdown turned into the Docs API's requests.

// the text of a document body, tables included
export function plainText(content: any[] = []): string {
  return content
    .map((s: any) => {
      if (s.paragraph) return (s.paragraph.elements ?? []).map((e: any) => e.textRun?.content ?? "").join("");
      if (s.table) return (s.table.tableRows ?? []).map((r: any) => (r.tableCells ?? []).map((c: any) => plainText(c.content).trim()).join("\t")).join("\n") + "\n";
      return "";
    })
    .join("");
}

const INLINE = /\*\*(.+?)\*\*|__(.+?)__|\*([^*]+?)\*|_([^_]+?)_|`(.+?)`|\[(.+?)\]\((.+?)\)/g;

// ponytail: headings, bullets, numbers, bold, italic, code and links; a Markdown table or image comes through as its plain text
export function markdownRequests(markdown: string, at: number, tabId?: string): any[] {
  const tab = tabId ? { tabId } : {};
  let text = "";
  const styles: any[] = [];
  const paragraphs: any[] = [];
  const lists: { start: number; end: number; numbered: boolean }[] = [];
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = raw.match(/^\s*\d+\.\s+(.*)$/);
    const line = heading?.[2] ?? bullet?.[1] ?? numbered?.[1] ?? raw;
    const start = at + text.length;
    let plain = "";
    let last = 0;
    for (const m of line.matchAll(INLINE)) {
      plain += line.slice(last, m.index);
      const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "";
      const range = { startIndex: start + plain.length, endIndex: start + plain.length + inner.length, ...tab };
      const textStyle = m[1] || m[2] ? { bold: true } : m[3] || m[4] ? { italic: true } : m[5] ? { weightedFontFamily: { fontFamily: "Courier New" } } : { link: { url: m[7] } };
      styles.push({ updateTextStyle: { range, textStyle, fields: Object.keys(textStyle)[0] } });
      plain += inner;
      last = m.index + m[0].length;
    }
    plain += line.slice(last);
    text += `${plain}\n`;
    const end = at + text.length;
    if (heading) paragraphs.push({ updateParagraphStyle: { range: { startIndex: start, endIndex: end, ...tab }, paragraphStyle: { namedStyleType: `HEADING_${heading[1]!.length}` }, fields: "namedStyleType" } });
    if (bullet || numbered) {
      const prev = lists.at(-1);
      if (prev && prev.end === start && prev.numbered === !bullet) prev.end = end;
      else lists.push({ start, end, numbered: !bullet });
    }
  }
  // list prefixes are already stripped, so making bullets moves nothing
  return [
    { insertText: { location: { index: at, ...tab }, text } },
    ...styles,
    ...paragraphs,
    ...lists.map((l) => ({ createParagraphBullets: { range: { startIndex: l.start, endIndex: l.end, ...tab }, bulletPreset: l.numbered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE" } })),
  ];
}
