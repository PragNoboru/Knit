import { redirect } from "next/navigation";

import { SyncProvider } from "@/components/sync-provider";
import { TopBar } from "@/components/top-bar";
import { getKnitToday } from "@/lib/screens";
import { getCurrentUser } from "@/lib/supabase/server";
import { formatDay } from "@/lib/time";

// PRD 7.3: Sync now runs a pull inside a server action on these pages. The plan's allowed
// maximum: see docs/RUNBOOK.md 2.3 before changing it.
export const maxDuration = 60;

// PRD 12.1: every screen here needs a signed-in, active Knit user.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Invariant 1: the date shown is the database's today (knit_today), as on Today itself.
  const today = await getKnitToday();
  return (
    <SyncProvider>
      <TopBar
        dateLabel={formatDay(today)}
        name={user.name}
        email={user.email}
        isAdmin={user.isAdmin}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:py-6">
        {children}
      </main>
    </SyncProvider>
  );
}
