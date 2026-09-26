import { normaliseKey, type TrackerConfig } from "./config";

/**
 * PRD 6.7, N3: owner cells to Knit users. An alias maps a normalised name to a user, or to a
 * known non-user (userId null). Unknown names raise one Needs Attention item per name per
 * tracker, never per row.
 */

export interface AliasMap {
  get(normalisedName: string): { userId: string | null } | undefined;
}

export function aliasMap(
  aliases: readonly { aliasNorm: string; userId: string | null }[],
): AliasMap {
  const map = new Map(aliases.map((a) => [a.aliasNorm, { userId: a.userId }]));
  return { get: (name) => map.get(name) };
}

/** "P + Agent" with separators [",", "+"] is ["p", "agent"]. Normalised, blanks dropped. */
export function splitOwners(
  raw: string | null | undefined,
  separators: readonly string[],
): string[] {
  let parts = [raw ?? ""];
  for (const separator of separators) {
    parts = parts.flatMap((part) => part.split(separator));
  }
  return parts.map(normaliseKey).filter((name) => name !== "");
}

export interface OwnerResolution {
  userIds: string[];
  knownNonUsers: string[];
  unknown: string[];
}

export function resolveOwners(
  raw: string | null | undefined,
  separators: readonly string[],
  aliases: AliasMap,
): OwnerResolution {
  const userIds = new Set<string>();
  const knownNonUsers = new Set<string>();
  const unknown = new Set<string>();
  for (const name of splitOwners(raw, separators)) {
    const alias = aliases.get(name);
    if (!alias) unknown.add(name);
    else if (alias.userId) userIds.add(alias.userId);
    else knownNonUsers.add(name);
  }
  return {
    userIds: [...userIds].sort(),
    knownNonUsers: [...knownNonUsers].sort(),
    unknown: [...unknown].sort(),
  };
}

/**
 * Who a row's task is assigned to (6.7). Without an owner column, the tracker's owner. With
 * `ownerFilter: "mine"`, only users named in the owner cell. With `"all"`, the tracker's
 * owner as well, so every row reaches them.
 */
export function assigneesFor(
  ownerCell: string | null | undefined,
  config: TrackerConfig,
  aliases: AliasMap,
  trackerOwnerId: string | null,
): { userIds: string[]; unknown: string[] } {
  if (config.columns.owner === null) {
    return { userIds: trackerOwnerId ? [trackerOwnerId] : [], unknown: [] };
  }
  const resolved = resolveOwners(ownerCell, config.ownerSeparators, aliases);
  const userIds = new Set(resolved.userIds);
  if (config.ownerFilter === "all" && trackerOwnerId)
    userIds.add(trackerOwnerId);
  return { userIds: [...userIds].sort(), unknown: resolved.unknown };
}
