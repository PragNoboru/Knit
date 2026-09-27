"use client";

import { useTransition } from "react";

import { Button } from "@/components/ui/button";

/** A button running one admin action, after an optional confirmation. */
export function ActionButton({
  action,
  children,
  confirm,
  variant = "outline",
  size = "sm",
}: {
  action: () => Promise<void>;
  children: React.ReactNode;
  confirm?: string;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  size?: "sm" | "xs" | "default";
}) {
  const [busy, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={busy}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        startTransition(() => action());
      }}
    >
      {children}
    </Button>
  );
}
