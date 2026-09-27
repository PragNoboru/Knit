"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { callAction } from "@/lib/actions/call";
import { syncStatus } from "@/lib/actions/tasks";
import type { SyncState } from "@/lib/domain/cards";
import type { ActionResult } from "@/lib/errors";

/**
 * PRD 12.3: after a status change a "Syncing" pill shows until the write-back reaches the
 * sheet. One poll every 3 s covers every task still pending on the page, and stops when none
 * is.
 */

const POLL_MS = 3_000;

type SyncStates = Readonly<Record<string, SyncState>>;

/** The tasks the poll follows: only pending ones (N18 h). */
export function pendingTaskIds(states: SyncStates): string[] {
  return Object.keys(states)
    .filter((id) => states[id] === "pending")
    .sort();
}

/**
 * One poll. A failed request (no connection) changes nothing: the next tick tries again, and
 * the page never sees an unhandled rejection.
 */
export async function pollSyncStates(
  ids: readonly string[],
  fetch: (ids: string[]) => Promise<ActionResult<Record<string, SyncState>>>,
): Promise<Record<string, SyncState> | null> {
  const result = await callAction(() => fetch([...ids]));
  if (!result.ok) return null;
  return Object.fromEntries(ids.map((id) => [id, result.data[id] ?? null]));
}

/**
 * What the page shows for a task: the newest thing it learned. A server render counts as new
 * when its value differs from the previous render's, so a write that landed (held or failed
 * becoming nothing), a retried one, or a new write-back from a correction (becoming pending)
 * all show; an action or poll result wins until the server says something new.
 */
export function adoptServerState(
  states: SyncStates,
  taskId: string,
  fromServer: SyncState,
  previousServer: SyncState | undefined,
): SyncStates {
  if (previousServer === fromServer) return states;
  return states[taskId] === fromServer && taskId in states
    ? states
    : { ...states, [taskId]: fromServer };
}

interface SyncContextValue {
  states: SyncStates;
  track: (taskId: string, state: SyncState) => void;
  adopt: (
    taskId: string,
    fromServer: SyncState,
    previousServer: SyncState | undefined,
  ) => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<SyncStates>({});
  const track = useCallback((taskId: string, state: SyncState) => {
    setStates((current) =>
      current[taskId] === state && taskId in current
        ? current
        : { ...current, [taskId]: state },
    );
  }, []);
  const adopt = useCallback(
    (
      taskId: string,
      fromServer: SyncState,
      previousServer: SyncState | undefined,
    ) =>
      setStates((current) =>
        adoptServerState(current, taskId, fromServer, previousServer),
      ),
    [],
  );

  const pendingKey = pendingTaskIds(states).join(",");

  useEffect(() => {
    if (pendingKey === "") return;
    const ids = pendingKey.split(",");
    let stopped = false;
    const timer = setInterval(async () => {
      const learned = await pollSyncStates(ids, syncStatus);
      if (stopped || learned === null) return;
      setStates((current) => ({ ...current, ...learned }));
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingKey]);

  const value = useMemo(
    () => ({ states, track, adopt }),
    [states, track, adopt],
  );
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * A task's sync state: what this page last learned (an action result, a poll or a server
 * render that changed). A pending task joins the poll.
 */
export function useSyncState(
  taskId: string,
  fromServer: SyncState,
): [SyncState, (state: SyncState) => void] {
  const context = useContext(SyncContext);
  if (!context) throw new Error("useSyncState needs a SyncProvider");
  const { states, track, adopt } = context;
  // undefined until the first render is adopted, so a mount always takes the server's value.
  const lastServer = useRef<SyncState | undefined>(undefined);
  useEffect(() => {
    adopt(taskId, fromServer, lastServer.current);
    lastServer.current = fromServer;
  }, [adopt, fromServer, taskId]);
  const set = useCallback(
    (state: SyncState) => track(taskId, state),
    [taskId, track],
  );
  return [taskId in states ? (states[taskId] ?? null) : fromServer, set];
}
