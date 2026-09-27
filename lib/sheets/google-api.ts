import { JWT } from "google-auth-library";

import { SheetError } from "./types";

/**
 * PRD 7.4: authenticated Google API calls through the service account, with exponential
 * backoff and jitter on 429 and 5xx. Shared by GoogleSheetSource and the Knit Archive.
 * Errors carry the HTTP status and Google's reason only: never sheet content.
 *
 * Retries never repeat a write:
 *   * 429 (quota): Google applied nothing, so every request is retried. The waits follow
 *     Google's Retry-After when it sends one, else 2, 4, 8, 16 s (plus jitter), within a total
 *     wait budget (35 s by default), since the Sheets quotas refill per minute.
 *   * 5xx: Google may have applied the request before failing. Only a request that gives the
 *     same result when sent twice (`idempotent`: every GET, and a values write to fixed cells)
 *     is sent again. Any other (an append, a structural batchUpdate) fails at once, and its
 *     caller re-runs the whole step, which re-reads the sheet first (invariant 8).
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
];

const TRANSIENT = new Set([500, 502, 503, 504]);
const RATE_LIMITED = 429;
const RATE_LIMIT_FIRST_WAIT_MS = 2_000;
const RATE_LIMIT_MAX_WAIT_MS = 16_000;
const RATE_LIMIT_BUDGET_MS = 35_000;

export interface GoogleApiOptions {
  /** The service account key (validated by lib/env.ts). */
  credentials?: { client_email: string; private_key: string };
  /** Replaces the service-account token, for tests. */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** The longest total wait on 429 answers for one request. */
  rateLimitBudgetMs?: number;
}

export interface GoogleRequestInit {
  method?: string;
  body?: unknown;
  /**
   * Whether sending the request twice gives the same result as sending it once, so it may be
   * repeated after a 5xx. Defaults to true for GET and false for anything else.
   */
  idempotent?: boolean;
}

export interface GoogleApi {
  request<T>(url: string, init?: GoogleRequestInit): Promise<T>;
}

/** Retry-After in seconds (the form Google uses), or null. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

export function createGoogleApi(options: GoogleApiOptions): GoogleApi {
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rateLimitBudget = options.rateLimitBudgetMs ?? RATE_LIMIT_BUDGET_MS;
  let getToken = options.getToken;
  if (!getToken) {
    if (!options.credentials)
      throw new Error("Google API calls need credentials");
    const jwt = new JWT({
      email: options.credentials.client_email,
      key: options.credentials.private_key,
      scopes: GOOGLE_SCOPES,
    });
    getToken = async () => {
      const { token } = await jwt.getAccessToken();
      if (!token)
        throw new SheetError("Google returned no access token", "api_error");
      return token;
    };
  }
  const token = getToken;

  return {
    async request<T>(url: string, init: GoogleRequestInit = {}): Promise<T> {
      const attempts = options.maxAttempts ?? 5;
      const method = init.method ?? "GET";
      const idempotent = init.idempotent ?? method === "GET";
      let rateLimitWaited = 0;
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${await token()}`,
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        if (response.ok) return (await response.json()) as T;
        if (response.status === 404) {
          throw new SheetError(
            `Not found: ${new URL(url).pathname}`,
            "file_not_found",
            404,
          );
        }

        let wait: number | null = null;
        if (response.status === RATE_LIMITED) {
          const planned =
            retryAfterMs(response) ??
            Math.min(
              RATE_LIMIT_MAX_WAIT_MS,
              RATE_LIMIT_FIRST_WAIT_MS * 2 ** (attempt - 1),
            ) + Math.floor(Math.random() * 1000);
          if (rateLimitWaited + planned <= rateLimitBudget) {
            wait = planned;
            rateLimitWaited += planned;
          }
        } else if (TRANSIENT.has(response.status) && idempotent) {
          const backoff = 500 * 2 ** (attempt - 1);
          wait = backoff + Math.floor(Math.random() * backoff);
        }

        if (wait === null || attempt >= attempts) {
          let reason = "";
          try {
            const body = (await response.json()) as {
              error?: { status?: string };
            };
            reason = body.error?.status ?? "";
          } catch {
            reason = "";
          }
          throw new SheetError(
            `Google API ${response.status} ${reason}`.trim(),
            "api_error",
            response.status,
          );
        }
        await sleep(wait);
      }
    },
  };
}
