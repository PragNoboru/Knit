"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/actions/admin";
import { withRequestErrors } from "@/lib/actions/call";
import { cn } from "@/lib/utils";

/**
 * A form posting to an admin server action, showing its error or notice in plain language,
 * and so a request that never reached the server (N48), instead of the whole-page error.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitVariant = "default",
  className,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  children?: React.ReactNode;
  submitLabel: string;
  submitVariant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(
    withRequestErrors(action, (error): FormState => ({ error })),
    { error: null },
  );
  return (
    <form action={formAction} className={cn("grid gap-4", className)}>
      {children}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.notice}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant={submitVariant} disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
