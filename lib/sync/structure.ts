import { normaliseKey, type TrackerConfig } from "@/lib/domain/config";
import { templateHeaders } from "@/lib/domain/templates";
import { KNIT_ID_HEADER, type TabStructure } from "@/lib/sheets/types";

/**
 * PRD 10.2 step 2, 6.8, N6, 14: a tracker's layout must still match its registry before
 * anything is read or written. Every mapped header must be there exactly once, the Knit ID
 * column must exist, and neither write target may hold formulas. Any problem pauses the
 * tracker with a reason the admin can act on (invariant 7).
 */

export interface StructureProblem {
  kind: "missing_header" | "missing_knit_id_column" | "formula_column";
  dedupeKey: string;
  /** The pause reason, shown in the banner: "Sapiens paused: column 'Status' not found." */
  reason: string;
  detail: Record<string, unknown>;
}

/** Every header the registry reads, as configured (not normalised). */
export function mappedHeaders(config: TrackerConfig): string[] {
  const { columns } = config;
  const headers = [
    columns.date,
    columns.title,
    columns.statusRead,
    columns.statusWrite,
    columns.completedOn,
    columns.owner,
    columns.sourceRef,
    columns.critical?.header ?? null,
    ...config.detailColumns,
    ...templateHeaders(config.titleTemplate),
    ...(config.subtitleTemplate
      ? templateHeaders(config.subtitleTemplate)
      : []),
  ].filter((h): h is string => h !== null && h !== "");
  const seen = new Set<string>();
  return headers.filter((h) => {
    const key = normaliseKey(h);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function checkStructure(
  structure: TabStructure,
  config: TrackerConfig,
): StructureProblem | null {
  const present = new Set(structure.headers.map((h) => h.normalised));
  const duplicates = new Set(structure.duplicateHeaders);

  for (const header of mappedHeaders(config)) {
    const key = normaliseKey(header);
    if (!present.has(key)) {
      return {
        kind: "missing_header",
        dedupeKey: `missing_header:${key}`,
        reason: `column '${header}' not found`,
        detail: { header },
      };
    }
    if (duplicates.has(key)) {
      return {
        kind: "missing_header",
        dedupeKey: `missing_header:${key}`,
        reason: `column '${header}' appears more than once`,
        detail: { header, duplicate: true },
      };
    }
  }

  if (!present.has(normaliseKey(KNIT_ID_HEADER))) {
    return {
      kind: "missing_knit_id_column",
      dedupeKey: "missing_knit_id_column",
      reason: "the Knit ID column is missing",
      detail: {},
    };
  }

  const readOnly = new Set([
    ...structure.formulaColumns,
    ...config.readOnlyColumns.map(normaliseKey),
  ]);
  for (const target of [
    config.columns.statusWrite,
    config.columns.completedOn,
  ]) {
    if (target && readOnly.has(normaliseKey(target))) {
      return {
        kind: "formula_column",
        dedupeKey: `formula_column:${normaliseKey(target)}`,
        reason: `column '${target}' holds formulas and cannot be written`,
        detail: { header: target },
      };
    }
  }
  return null;
}
