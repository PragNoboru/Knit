"use client";

import { createContext, useContext, useState } from "react";

import type { FormState } from "@/lib/actions/admin";

/**
 * PRD 12.8: the outcome of an action that removes its own item from Needs Attention, such as
 * "Request dismissed." (N86). The action refreshes the page, the item leaves the list of open
 * items and its form unmounts with it, so the notice is shown here, by the page, which stays.
 */

type Announce = (notice: string) => void;

const AnnounceContext = createContext<Announce>(() => undefined);

/** The action, with its notice told to `announce` instead of the form that sent it. */
export function announcing(
  action: (state: FormState, form: FormData) => Promise<FormState>,
  announce: Announce,
): (state: FormState, form: FormData) => Promise<FormState> {
  return async (state, form) => {
    const result = await action(state, form);
    if (!result.notice) return result;
    announce(result.notice);
    return { ...result, notice: null };
  };
}

/** The page's status line, and the context its items announce through. */
export function AttentionNotices({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <AnnounceContext.Provider value={setNotice}>
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      {children}
    </AnnounceContext.Provider>
  );
}

export const useAnnounce = () => useContext(AnnounceContext);
