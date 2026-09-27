"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/actions/admin";
import { callVoidAction } from "@/lib/actions/call";

/**
 * A button running one admin action, after an optional confirmation. What the action says
 * back (a refusal, or a notice) shows under the button in plain language, and so does a
 * request that never reached the server.
 */
export function ActionButton({
  action,
  children,
  confirm,
  variant = "outline",
  size = "sm",
}: {
  action: () => Promise<FormState | void>;
  children: React.ReactNode;
  confirm?: string;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "sm" | "xs" | "default";
}) {
  const [busy, startTransition] = useTransition();
  const [said, setSaid] = useState<FormState | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={busy}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setSaid(null);
          startTransition(async () => {
            const result = await callVoidAction(action);
            setSaid(
              result.ok ? (result.value ?? null) : { error: result.error },
            );
          });
        }}
      >
        {children}
      </Button>
      {said?.error ? (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {said.error}
        </span>
      ) : said?.notice ? (
        <span role="status" className="max-w-64 text-xs text-muted-foreground">
          {said.notice}
        </span>
      ) : null}
    </span>
  );
}
