/**
 * PRD 19, CLAUDE.md: structured JSON logs on the server with the job name, tracker id and run
 * id. Callers pass ids, counts and error codes only: never sheet content, tokens or keys.
 */
export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
  );
}

/** An error's name and message, without stack or payloads, for logs and sync_runs. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}
