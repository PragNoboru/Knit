import { normaliseKey, type TrackerConfig } from "@/lib/domain/config";
import { templateHeaders } from "@/lib/domain/templates";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type TabStructure,
} from "@/lib/sheets/types";

/**
 * PRD 10.2 step 2, 6.8, 7.3, N6, D7, 14: a tracker's layout must still match its registry
 * before anything is read or written. Every mapped header must be there exactly once, Knit's
 * own columns (Knit ID and Knit Note) must each be there exactly once, and no column Knit
 * writes (status, completed-on, Knit ID, Knit Note) may hold formulas. Any problem pauses the
 * tracker with a reason the admin can act on (invariant 7), and its write-backs are held until
 * it resumes (10.4 step 1).
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
  // D7: every push writes the Knit Note, so without its column no write-back could land.
  if (!present.has(normaliseKey(KNIT_NOTE_HEADER))) {
    return {
      kind: "missing_header",
      dedupeKey: `missing_header:${normaliseKey(KNIT_NOTE_HEADER)}`,
      reason: "the Knit Note column is missing",
      detail: { header: KNIT_NOTE_HEADER },
    };
  }
  // Knit reads and writes its columns by header, first match only: a copy would be ignored.
  for (const header of [KNIT_ID_HEADER, KNIT_NOTE_HEADER]) {
    const key = normaliseKey(header);
    if (duplicates.has(key)) {
      return {
        kind: "missing_header",
        dedupeKey: `missing_header:${key}`,
        reason: `column '${header}' appears more than once`,
        detail: { header, duplicate: true },
      };
    }
  }

  const readOnly = new Set([
    ...structure.formulaColumns,
    ...config.readOnlyColumns.map(normaliseKey),
  ]);
  for (const target of [
    config.columns.statusWrite,
    config.columns.completedOn,
    KNIT_ID_HEADER,
    KNIT_NOTE_HEADER,
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
