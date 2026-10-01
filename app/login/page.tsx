import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BrandMark } from "@/components/brand-mark";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser, getSupabase } from "@/lib/supabase/server";
import { firstParam, safeNextPath } from "@/lib/url";

export const metadata: Metadata = { title: "Sign in · Knit" };

// PRD 12.1: /login, email and password.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // 9.3: only a path inside Knit, never another site (an open redirect).
  const safeNext = safeNextPath(firstParam(params, "next"));
  if (await getCurrentUser()) redirect(safeNext ?? "/");

  // Signed in to Supabase but not an active Knit user: the admin deactivated the account.
  const { data } = await (await getSupabase()).auth.getClaims();
  const notice = data?.claims.sub
    ? "This account is not active. Ask the admin."
    : null;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <BrandMark className="h-7" />
          Knit
        </h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Sign in with the email and password the admin gave you.
        </p>
        <LoginForm next={safeNext} notice={notice} />
      </div>
    </main>
  );
}
