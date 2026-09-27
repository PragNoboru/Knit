/**
 * PRD 10.2 step 2, 14, N43: the pause reason the structure check (lib/sync/structure.ts) gives a
 * tracker whose Knit ID column is missing, stored as the tracker's pause_reason.
 */
export const MISSING_KNIT_ID_REASON = "the Knit ID column is missing";

/**
 * N43: only a tracker paused because its Knit ID column is gone goes to the recreate flow, after
 * the admin checks the preview on the tracker's page. A tracker paused for any other reason, a
 * doubled Knit ID column or a formula in it included (N39), is fixed in the sheet and resumed:
 * the reason is matched exactly, never by the words it contains.
 */
export const pausedForMissingKnitIds = (pauseReason: string | null) =>
  pauseReason === MISSING_KNIT_ID_REASON;
