import { DayScreen } from "./_parts/day-screen";

// PRD 12.3: Today.
export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <DayScreen day={null} path="/" params={await searchParams} banners />;
}
