"use client";

import { AppErrorPanel } from "@/components/app-error";

// PRD 14: when Supabase is unavailable the UI shows an error page with a retry.
export default function AppError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <AppErrorPanel retry={retry} />;
}
