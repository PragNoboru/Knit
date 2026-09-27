"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { syncStatus } from "@/lib/actions/tasks";
import type { SyncState } from "@/lib/domain/cards";

/**
 * PRD 12.3: after a status change a "Syncing" pill shows until the write-back reaches the
 * sheet. One poll every 3 s covers every task still pending on the page, and stops when none
 * is.
 */

const POLL_MS = 3_000;

interface SyncContextValue {
  states: Readonly<Record<string, SyncState>>;
  track: (taskId: string, state: SyncState) => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<Record<string, SyncState>>({});
  const track = useCallback((taskId: string, state: SyncState) => {
    setStates((current) =>
      current[taskId] === state ? current : { ...current, [taskId]: state },
    );
  }, []);

  const pendingKey = Object.keys(states)
    .filter((id) => states[id] === "pending")
    .sort()
    .join(",");

  useEffect(() => {
    if (pendingKey === "") return;
    const ids = pendingKey.split(",");
    let stopped = false;
    const timer = setInterval(async () => {
      const result = await syncStatus(ids);
      if (stopped || !result.ok) return;
      setStates((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = result.data[id] ?? null;
        return next;
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingKey]);

  const value = useMemo(() => ({ states, track }), [states, track]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * A task's sync state: what this page last learned (an action result or a poll), else what
 * the server rendered. A pending task joins the poll.
 */
export function useSyncState(
  taskId: string,
  fromServer: SyncState,
): [SyncState, (state: SyncState) => void] {
  const context = useContext(SyncContext);
  if (!context) throw new Error("useSyncState needs a SyncProvider");
  const { states, track } = context;
  const known = taskId in states;
  useEffect(() => {
    if (!known && fromServer === "pending") track(taskId, fromServer);
  }, [known, fromServer, taskId, track]);
  const set = useCallback(
    (state: SyncState) => track(taskId, state),
    [taskId, track],
  );
  return [known ? (states[taskId] ?? null) : fromServer, set];
}
