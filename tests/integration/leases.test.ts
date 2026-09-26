import { describe, expect, it } from "vitest";

import { createUser } from "./support/builders";
import { queryAs, useTestDb } from "./support/db";

const SERVICE = { kind: "service" } as const;

async function acquire(
  db: ReturnType<ReturnType<typeof useTestDb>>,
  job: string,
  ttl = 60,
) {
  const rows = await queryAs<{ holder: string | null }>(
    db,
    SERVICE,
    "select acquire_lease($1, $2) as holder",
    [job, ttl],
  );
  return rows[0]!.holder;
}

// PRD 7.3, 9.1: one running instance per job.
describe("job leases (PRD 7.3)", () => {
  const db = useTestDb();

  it("gives the lease to one caller at a time", async () => {
    const first = await acquire(db(), "pull");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await acquire(db(), "pull")).toBeNull();
    // Leases are per job.
    expect(await acquire(db(), "push")).not.toBeNull();
  });

  it("frees the lease when its holder releases it, and only then", async () => {
    const holder = await acquire(db(), "close");
    const [wrong] = await queryAs(
      db(),
      SERVICE,
      "select release_lease('close', gen_random_uuid()) as released",
    );
    expect(wrong).toEqual({ released: false });
    const [right] = await queryAs(
      db(),
      SERVICE,
      "select release_lease('close', $1) as released",
      [holder],
    );
    expect(right).toEqual({ released: true });
    expect(await acquire(db(), "close")).not.toBeNull();
  });

  it("lets a new caller take over an expired lease, so a crashed job cannot block forever", async () => {
    await acquire(db(), "structure");
    await db().query(
      "update job_leases set expires_at = now() - interval '1 second' where job = 'structure'",
    );
    expect(await acquire(db(), "structure")).not.toBeNull();
  });

  it("is refused to signed-in users", async () => {
    const admin = await createUser(db(), { role: "admin" });
    await expect(
      queryAs(
        db(),
        { kind: "user", id: admin },
        "select acquire_lease('pull', 60)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
