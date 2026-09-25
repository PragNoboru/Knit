import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env";
import { EnvError, parsePublicEnv, supabaseKeyKind } from "@/lib/public-env";
import {
  FAKE_CRON_SECRET,
  FAKE_PRIVATE_KEY,
  fakeServiceAccountBase64,
  fakeSupabaseJwt,
  validEnv,
} from "@/tests/support/fake-env";

/** Runs parseServerEnv and returns the error message it throws. */
function envError(overrides: Record<string, string | undefined>): string {
  try {
    parseServerEnv({ ...validEnv(), ...overrides });
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).message;
  }
  throw new Error("expected parseServerEnv to throw");
}

describe("parseServerEnv (PRD 18.1)", () => {
  it("accepts a complete environment and decodes the service account key", () => {
    const env = parseServerEnv(validEnv());
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.GOOGLE_SERVICE_ACCOUNT_JSON.client_email).toBe(
      "knit-sync@knit-test.iam.gserviceaccount.com",
    );
    expect(env.GOOGLE_SERVICE_ACCOUNT_JSON.private_key).toBe(FAKE_PRIVATE_KEY);
  });

  it("accepts the new publishable and secret Supabase keys", () => {
    const env = parseServerEnv({
      ...validEnv(),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_def456",
    });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("sb_secret_def456");
  });

  it("names every missing variable in one error", () => {
    const message = envError(
      Object.fromEntries(
        Object.keys(validEnv()).map((key) => [key, undefined]),
      ),
    );
    for (const key of Object.keys(validEnv())) {
      expect(message).toContain(`${key}: is missing`);
    }
  });

  it("treats an empty or blank value as missing", () => {
    expect(envError({ KNIT_DRIVE_FOLDER_ID: "   " })).toContain(
      "KNIT_DRIVE_FOLDER_ID: is empty",
    );
  });

  it("never puts a value into the error message", () => {
    const secrets = validEnv();
    const message = envError({
      APP_URL: "not a url",
      KNIT_ARCHIVE_SHEET_ID: "bad id!",
    });
    for (const value of Object.values(secrets)) {
      if (value) expect(message).not.toContain(value);
    }
    expect(message).not.toContain("not a url");
    expect(message).not.toContain(FAKE_CRON_SECRET);
  });

  it("refuses a service-role key in the browser variable", () => {
    expect(
      envError({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeSupabaseJwt("service_role"),
      }),
    ).toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: holds a service-role or secret key",
    );
    expect(
      envError({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_def456" }),
    ).toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: holds a service-role or secret key",
    );
  });

  it("refuses the public key in the service-role variable", () => {
    expect(
      envError({ SUPABASE_SERVICE_ROLE_KEY: fakeSupabaseJwt("anon") }),
    ).toContain(
      "SUPABASE_SERVICE_ROLE_KEY: holds the public anon or publishable key",
    );
  });

  it("refuses values that are not Supabase keys at all", () => {
    expect(envError({ SUPABASE_SERVICE_ROLE_KEY: "hello" })).toContain(
      "SUPABASE_SERVICE_ROLE_KEY: is not a Supabase service-role or secret key",
    );
    expect(envError({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "a.b.c" })).toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: is not a Supabase anon or publishable key",
    );
  });

  it("requires a service account key file, base64-encoded", () => {
    expect(envError({ GOOGLE_SERVICE_ACCOUNT_JSON: "{not base64}" })).toContain(
      "GOOGLE_SERVICE_ACCOUNT_JSON: is not base64-encoded JSON",
    );
    expect(
      envError({
        GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccountBase64({ type: "user" }),
      }),
    ).toContain(
      "GOOGLE_SERVICE_ACCOUNT_JSON: is not a Google service account key",
    );
    expect(
      envError({
        GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccountBase64({
          private_key: "nope",
        }),
      }),
    ).toContain(
      "GOOGLE_SERVICE_ACCOUNT_JSON: is not a Google service account key",
    );
  });

  it("accepts base64 that `base64` wrapped over several lines", () => {
    const wrapped = fakeServiceAccountBase64().replace(/(.{76})/g, "$1\n");
    expect(wrapped).toContain("\n");
    const env = parseServerEnv({
      ...validEnv(),
      GOOGLE_SERVICE_ACCOUNT_JSON: wrapped,
    });
    expect(env.GOOGLE_SERVICE_ACCOUNT_JSON.type).toBe("service_account");
  });

  it("requires a long cron secret", () => {
    expect(envError({ KNIT_CRON_SECRET: "short" })).toContain(
      "KNIT_CRON_SECRET: must be at least 32 characters",
    );
  });

  it("requires http(s) base URLs without a trailing slash", () => {
    expect(envError({ APP_URL: "https://knit.example.com/" })).toContain(
      "APP_URL: must not end with a slash",
    );
    expect(envError({ APP_URL: "ftp://knit.example.com" })).toContain(
      "APP_URL: must be an http or https URL",
    );
    expect(envError({ NEXT_PUBLIC_SUPABASE_URL: "localhost:54321" })).toContain(
      "NEXT_PUBLIC_SUPABASE_URL: must be an http or https URL",
    );
  });

  it("requires Google Drive ids to look like ids", () => {
    expect(
      envError({ KNIT_DRIVE_FOLDER_ID: "https://drive.google.com/x" }),
    ).toContain("KNIT_DRIVE_FOLDER_ID: is not a Google Drive id");
  });
});

describe("parsePublicEnv", () => {
  it("accepts the two public variables", () => {
    const env = parsePublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abc123",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://project.supabase.co");
  });

  it("refuses a secret key", () => {
    expect(() =>
      parsePublicEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeSupabaseJwt("service_role"),
      }),
    ).toThrow(EnvError);
  });
});

describe("supabaseKeyKind", () => {
  it.each([
    [fakeSupabaseJwt("anon"), "anon"],
    [fakeSupabaseJwt("service_role"), "service_role"],
    [fakeSupabaseJwt("authenticated"), "unknown"],
    ["sb_publishable_abc", "publishable"],
    ["sb_secret_abc", "secret"],
    ["eyJ.not-json.sig", "unknown"],
    ["", "unknown"],
  ])("classifies %s as %s", (key, kind) => {
    expect(supabaseKeyKind(key)).toBe(kind);
  });
});
