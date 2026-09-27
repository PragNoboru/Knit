/** Search params as Next.js passes them to a page. */
export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `path` with the current search params changed: a value sets a param, null removes it. Used
 * for the task drawer (?task=, PRD 12.1) and filters, so opening one keeps the others.
 */
export function hrefWith(
  path: string,
  params: SearchParams,
  changes: Record<string, string | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value])
      search.append(key, one);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) search.delete(key);
    else search.set(key, value);
  }
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}

/** The first value of a search param. */
export function firstParam(
  params: SearchParams,
  key: string,
): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

const INSIDE_KNIT = "http://knit.invalid";

/** A backslash or a control character: browsers read "/\" as "//" and drop tabs and newlines. */
const hasUnsafeCharacter = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char === "\\" || code < 0x20 || code === 0x7f;
  });

/**
 * PRD 9.3, 12.1: where to go after signing in, only when it is a path inside Knit. Anything a
 * browser would resolve to another site ("//evil.com", "/\evil.com", "/<tab>/evil.com", a full
 * URL) gives undefined, so /login can never be used as an open redirect.
 */
export function safeNextPath(
  next: string | null | undefined,
): string | undefined {
  if (!next || !next.startsWith("/") || hasUnsafeCharacter(next))
    return undefined;
  try {
    const url = new URL(next, INSIDE_KNIT);
    return url.origin === INSIDE_KNIT
      ? url.pathname + url.search + url.hash
      : undefined;
  } catch {
    return undefined;
  }
}
