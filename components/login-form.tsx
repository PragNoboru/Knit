"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, type SignInState } from "@/lib/actions/auth";
import { withRequestErrors } from "@/lib/actions/call";

/** PRD 12.1 /login: email and password (D6: the admin creates every login). */
export function LoginForm({
  next,
  notice,
}: {
  next: string | undefined;
  notice: string | null;
}) {
  // N48: a sign-in that never reached the server says so here, not on the error page.
  const [state, action, pending] = useActionState<SignInState, FormData>(
    withRequestErrors(signIn, (error): SignInState => ({ error })),
    { error: notice },
  );
  return (
    <form action={action} className="grid gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in" : "Sign in"}
      </Button>
    </form>
  );
}
