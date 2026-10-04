/** Hashtags are exact tags. Quote names containing spaces: #"green trees". */
export function parseSearch(query: string) {
  const tokens: { start: number; end: number; name: string }[] = [];
  const text = query.replace(
    /(^|\s)#("(?:\\.|[^"\\])*(?:"|$)|[^\s"]*)/g,
    (match: string, space: string, raw: string, offset: number) => {
      let name = raw;
      if (raw.startsWith('"')) {
        try {
          name = JSON.parse(raw) as string;
        } catch {
          name = raw.slice(1).replace(/\\(["\\])/g, '$1');
        }
      }
      tokens.push({
        start: offset + space.length,
        end: offset + match.length,
        name: name.trim().toLowerCase(),
      });
      return space;
    },
  );
  return {
    text: text.trim(),
    tags: [...new Set(tokens.map((token) => token.name).filter(Boolean))],
    tokens,
  };
}

export function formatTagSearch(name: string) {
  return `#${/^[^\s"\\]+$/.test(name) ? name : JSON.stringify(name)}`;
}

export function appendTagSearch(query: string, name: string) {
  if (parseSearch(query).tags.includes(name.toLowerCase())) return query;
  return [query.trim(), formatTagSearch(name)].filter(Boolean).join(' ');
}
