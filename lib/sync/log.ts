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

/**
 * An error as a log line may carry it: a short code and, when there is one, the HTTP status.
 * Never the message, which can name a file, a folder or a value (PRD N88). A code that is not a
 * short identifier (letters, digits, `_`, `-`, `.`) is logged as "unknown".
 */
export function errorCode(error: unknown): { code: string; status?: number } {
  if (typeof error !== "object" || error === null) return { code: "unknown" };
  const raw = "code" in error ? (error as { code: unknown }).code : undefined;
  const text = typeof raw === "number" ? String(raw) : raw;
  const code =
    typeof text === "string" && /^[\w.-]{1,64}$/.test(text) ? text : "unknown";
  const status =
    "status" in error ? (error as { status: unknown }).status : undefined;
  return typeof status === "number" && Number.isInteger(status) && status > 0
    ? { code, status }
    : { code };
}
