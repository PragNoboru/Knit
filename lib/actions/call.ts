import { unstable_rethrow } from "next/navigation";

import { fail, NETWORK_ERROR, type ActionResult } from "@/lib/errors";

/**
 * CLAUDE.md conventions, PRD 12.3: a server action answers with a typed result, and the screen
 * shows a refusal in plain language. When the request itself fails (a phone loses its
 * connection, a timeout), the action's promise rejects instead; inside a transition React
 * would then replace the whole page with the error page. This turns that into the same typed
 * result, so the control shows it inline and an optimistic change rolls back. Next.js's own
 * redirects and not-found signals pass through unchanged.
 */
export async function callAction<T>(
  run: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    return fail(NETWORK_ERROR);
  }
}

/** The same, for an action with no typed result: the error text, or null when it went through. */
export async function callVoidAction<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: NETWORK_ERROR };
  }
}
