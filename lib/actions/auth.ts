"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getSupabase } from "@/lib/supabase/server";

// PRD 13: signIn and signOut (Supabase Auth, email and password, D6).

export interface SignInState {
  error: string | null;
}

const SignInInput = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
  next: z.string().max(2000).optional(),
});

/** Only paths inside Knit: never another site (an open redirect). */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signIn(
  _previous: SignInState,
  form: FormData,
): Promise<SignInState> {
  const parsed = SignInInput.safeParse({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
    next: form.get("next") ? String(form.get("next")) : undefined,
  });
  if (!parsed.success) return { error: "Enter your email and password." };
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return {
      error:
        error?.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That email and password don't match.",
    };
  }
  const { data: row } = await supabase
    .from("app_users")
    .select("is_active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!z.object({ is_active: z.literal(true) }).safeParse(row).success) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "This account is not active. Ask the admin." };
  }
  redirect(safeNext(parsed.data.next));
}

export async function signOut(): Promise<void> {
  const supabase = await getSupabase();
  // Only this browser's session: a sign-out here must not end the user's other devices.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
