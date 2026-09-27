"use client";

import { AppErrorPanel } from "@/components/app-error";

// PRD 14: the same error page for failures that app/(app)/error.tsx cannot catch, such as the
// signed-in user lookup in app/(app)/layout.tsx (an error.tsx never covers its own layout).
export default function RootError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <AppErrorPanel retry={retry} />
    </main>
  );
}
