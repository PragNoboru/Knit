import { normaliseKey } from "./config";

/**
 * PRD 8.2: title and subtitle templates reference headers in braces, for example
 * "{Asset ID} · {Working title}". Missing values render as empty and the separator next to them
 * collapses, so "{ID} · {Phase}" with no Phase is just "G01".
 */

interface Field {
  header: string;
  /** The text between the previous field (or the start) and this field. */
  before: string;
}

function parse(template: string): { fields: Field[]; after: string } {
  const fields: Field[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    fields.push({
      header: match[1]!,
      before: template.slice(last, match.index),
    });
    last = match.index + match[0].length;
  }
  return { fields, after: template.slice(last) };
}

/** The headers a template reads. */
export function templateHeaders(template: string): string[] {
  return parse(template).fields.map((field) => field.header);
}

/**
 * Renders a template. `lookup` receives the normalised header. The text before a field is kept
 * when it joins two values (or is the leading text of the first field); trailing text only
 * when the last field has a value.
 */
export function renderTemplate(
  template: string,
  lookup: (normalisedHeader: string) => string | null | undefined,
): string {
  const { fields, after } = parse(template);
  if (fields.length === 0) return after.trim();
  let out = "";
  let lastKept = -1;
  fields.forEach((field, index) => {
    const value = (lookup(normaliseKey(field.header)) ?? "").trim();
    if (value === "") return;
    if (lastKept >= 0 || index === 0) out += field.before;
    out += value;
    lastKept = index;
  });
  if (lastKept === fields.length - 1) out += after;
  return out.replace(/\s+/g, " ").trim();
}
