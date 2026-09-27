import { notFound } from "next/navigation";

import { AdminNav } from "@/components/admin/admin-nav";
import { getCurrentUser, getSupabase } from "@/lib/supabase/server";

// PRD 12.1: the admin screens, for the admin only (the database checks it again, 9).
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) notFound();
  const { count } = await (
    await getSupabase()
  )
    .from("attention_items")
    .select("id", { count: "exact", head: true })
    .eq("state", "open");
  return (
    <div className="flex flex-col gap-5">
      <AdminNav attention={count ?? 0} />
      {children}
    </div>
  );
}
