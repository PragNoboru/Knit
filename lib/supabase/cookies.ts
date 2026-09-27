import type { CookieOptionsWithName } from "@supabase/ssr";

/** D5: a session is kept 30 days; every refresh starts the 30 days again. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Options for the Supabase Auth cookies. Knit reads the session only on the server (proxy,
 * Server Components and server actions), so the cookies are httpOnly: page scripts never
 * see the tokens.
 */
export function authCookieOptions(appUrl: string): CookieOptionsWithName {
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: appUrl.startsWith("https://"),
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
