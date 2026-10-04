import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Guide } from "@/components/guide";
import { loadTemplateLink } from "@/lib/guide";
import { getCurrentUser } from "@/lib/supabase/server";
import { loadMyTrackerRequests } from "@/lib/tracker-request";

export const metadata: Metadata = { title: "Guide · Knit" };

// PRD 12.9 (N77 to N85, N89): how to use Knit, for every signed-in user. The admin sections are
// rendered for the admin only; the page reads nothing from the database but the template link
// and the person's own tracker requests (N79 as amended by N83, N85).
export default async function GuidePage() {
  // The layout renders alongside the page, so the page checks the user itself before it reads
  // the link with the service role (9.3).
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [template, requests] = await Promise.all([
    loadTemplateLink(),
    loadMyTrackerRequests(user.id),
  ]);
  return (
    <Guide isAdmin={user.isAdmin} template={template} requests={requests} />
  );
}
