// Fake but well-formed environment values for env tests. None of these are
// real credentials.

const base64Url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A legacy Supabase key: a JWT whose `role` claim says what it is. */
export function fakeSupabaseJwt(role: string): string {
  return [
    base64Url({ alg: "HS256", typ: "JWT" }),
    base64Url({ iss: "supabase-demo", role }),
    "signature",
  ].join(".");
}

export const FAKE_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEfakeKeyForTestsOnly\n-----END PRIVATE KEY-----\n";

export function fakeServiceAccountBase64(
  overrides: Record<string, unknown> = {},
): string {
  const key = {
    type: "service_account",
    project_id: "knit-test",
    private_key: FAKE_PRIVATE_KEY,
    client_email: "knit-sync@knit-test.iam.gserviceaccount.com",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(key)).toString("base64");
}

export const FAKE_CRON_SECRET = "cron-secret-for-tests-".padEnd(48, "x");

export function validEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: fakeSupabaseJwt("anon"),
    SUPABASE_SERVICE_ROLE_KEY: fakeSupabaseJwt("service_role"),
    GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccountBase64(),
    KNIT_DRIVE_FOLDER_ID: "1FakeFolderId_abcdefghij",
    KNIT_ARCHIVE_SHEET_ID: "1FakeArchiveSheetId-abcdef",
    KNIT_CRON_SECRET: FAKE_CRON_SECRET,
    APP_URL: "http://localhost:3000",
  };
}
