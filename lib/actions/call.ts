import { unstable_rethrow } from "next/navigation";

import { fail, NETWORK_ERROR, type ActionResult } from "@/lib/errors";

/**
 * CLAUDE.md conventions, PRD 12.3, N48: a server action answers with a typed result, and the
 * screen shows a refusal in plain language. When the request itself never reaches the server
 * (a phone loses its connection), the action's promise rejects instead; inside a transition
 * React would then replace the whole page with the error page. This turns that into the same
 * typed result, so the control shows it inline and an optimistic change rolls back.
 *
 * Only such a request is: an action that reached the server and failed there (the database is
 * unavailable, or the page is older than the deployment) is rethrown, so the error page with
 * its retry shows it (PRD 14), never a connection message that retrying cannot fix. Next.js's
 * own redirects and not-found signals pass through unchanged.
 */

/**
 * The request never reached the server: fetch rejects with a TypeError when it gets no answer
 * ("Failed to fetch", "Load failed", "NetworkError"), and the browser may know it is offline. An
 * error the server threw reaches the page as an Error rebuilt from the server's answer.
 */
export function neverReachedServer(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return true;
  return error instanceof TypeError;
}

export async function callAction<T>(
  run: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    if (!neverReachedServer(error)) throw error;
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
    if (!neverReachedServer(error)) throw error;
    return { ok: false, error: NETWORK_ERROR };
  }
}

/**
 * The same, for a form action given to useActionState (the admin forms, sign-in): a request
 * that never reached the server becomes the form's error, shown under the form.
 */
export function withRequestErrors<S>(
  action: (state: S, form: FormData) => Promise<S>,
  withError: (error: string) => S,
): (state: S, form: FormData) => Promise<S> {
  return async (state, form) => {
    const result = await callVoidAction(() => action(state, form));
    return result.ok ? result.value : withError(result.error);
  };
}
