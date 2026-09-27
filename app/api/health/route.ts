import { createServiceClient } from "@/lib/supabase/service";

// PRD 13: GET /api/health: ok, whether the database answers, and the last closed day. No
// secrets and nothing about tasks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await createServiceClient()
      .from("day_closures")
      .select("day")
      .eq("state", "closed")
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const lastClosedDay =
      data && typeof data.day === "string" ? data.day : null;
    return Response.json({ ok: true, db: true, lastClosedDay });
  } catch {
    return Response.json(
      { ok: false, db: false, lastClosedDay: null },
      { status: 503 },
    );
  }
}
