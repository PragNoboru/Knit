import { notFound } from "next/navigation";

import { isLocalDate } from "@/lib/time";

import { DayScreen } from "../../_parts/day-screen";

// PRD 12.1, 12.4: /day/yyyy-mm-dd, the same layout as Today for any date.
export default async function DayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date } = await params;
  if (!isLocalDate(date)) notFound();
  return (
    <DayScreen day={date} path={`/day/${date}`} params={await searchParams} />
  );
}
