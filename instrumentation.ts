/**
 * Runs once when a Knit server starts, before it serves any request.
 * PRD 18.1: refuse to start when an environment variable is missing or
 * invalid, naming each variable (never its value).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerEnv } = await import("@/lib/env");
  getServerEnv();
}
