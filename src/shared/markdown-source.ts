/** Preserve Markdown containers when translating LaTeX display delimiters. */
export function markdownSource(text: string): string {
  const source = text.replace(/^\s*<proposed_plan>\s*\n([\s\S]*?)\n\s*<\/proposed_plan>\s*$/, '$1');
  function prose(value: string) {
    // Inline code may contain backticks and newlines; match its whole delimiter run.
    let consumed = 0;
    return value
      .split(/((?<!`)(`+)(?!`)[\s\S]*?(?<!`)\2(?!`))/g)
      .map((part, index) => {
        // split includes the nested delimiter capture as well as the whole code span.
        if (index % 3 === 1) {
          consumed += part.length;
          return part;
        }
        if (index % 3 === 2) return '';
        const startOffset = consumed;
        consumed += part.length;
        return part
          .replace(/\\\[([\s\S]*?)\\\]/g, (match, body: string, offset: number, input: string) => {
            const absolute = startOffset + offset;
            const before = value.slice(value.lastIndexOf('\n', absolute - 1) + 1, absolute);
            const prefix = /^(\s*(?:>[^\S\n]*)*)/.exec(before)?.[1] ?? '';
            const ownLine = before === prefix;
            const after = input.slice(offset + match.length).split('\n')[0];
            const start = body.startsWith('\n') ? '' : `\n${prefix}`;
            const lastLine = body.slice(body.lastIndexOf('\n') + 1);
            const end = lastLine === prefix || (!prefix && lastLine.trim() === '') ? '' : `\n${prefix}`;
            return `${ownLine ? '' : `\n${prefix}`}$$${start}${body}${end}$$${after.trim() ? `\n${prefix}` : ''}`;
          })
          .replace(/\\\(([^\n]*?)\\\)/g, (_match, body: string) => `$${body}$`);
      })
      .join('');
  }
  let result = '',
    pending = '',
    fence: { character: string; length: number } | undefined;
  for (const line of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const marker = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
    } else if (marker) {
      result += prose(pending) + line;
      pending = '';
      fence = { character: marker[1][0], length: marker[1].length };
    } else pending += line;
  }
  return result + prose(pending);
}
