import { JWT } from "google-auth-library";

import { SheetError } from "./types";

/**
 * PRD 7.4: authenticated Google API calls through the service account, with exponential
 * backoff and jitter on 429 and 5xx. Shared by GoogleSheetSource and the Knit Archive.
 * Errors carry the HTTP status and Google's reason only: never sheet content.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
];

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface GoogleApiOptions {
  /** The service account key (validated by lib/env.ts). */
  credentials?: { client_email: string; private_key: string };
  /** Replaces the service-account token, for tests. */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export interface GoogleApi {
  request<T>(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T>;
}

export function createGoogleApi(options: GoogleApiOptions): GoogleApi {
  const fetchImpl = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    async request<T>(
      url: string,
      init: { method?: string; body?: unknown } = {},
    ): Promise<T> {
      const attempts = options.maxAttempts ?? 5;
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetchImpl(url, {
          method: init.method ?? "GET",
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
          );
        }
        if (!RETRYABLE.has(response.status) || attempt >= attempts) {
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
          );
        }
        const backoff = 500 * 2 ** (attempt - 1);
        await sleep(backoff + Math.floor(Math.random() * backoff));
      }
    },
  };
}
