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
