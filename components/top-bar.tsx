"use client";

import { LogOut, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/actions/auth";
import { syncNow } from "@/lib/actions/tasks";
import { cn } from "@/lib/utils";

/** PRD 12.2: wordmark, date, links (Today, Calendar, All Tasks, Admin), Sync now, user menu. */
export function TopBar({
  dateLabel,
  name,
  email,
  isAdmin,
}: {
  dateLabel: string;
  name: string;
  email: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const [, startSignOut] = useTransition();
  const links = [
    { href: "/", label: "Today", active: pathname === "/" },
    {
      href: "/calendar",
      label: "Calendar",
      active: pathname.startsWith("/calendar") || pathname.startsWith("/day"),
    },
    { href: "/tasks", label: "All Tasks", active: pathname === "/tasks" },
    ...(isAdmin
      ? [
          {
            href: "/admin/trackers",
            label: "Admin",
            active: pathname.startsWith("/admin"),
          },
        ]
      : []),
  ];

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight"
          aria-label="Knit, Today"
        >
          Knit
        </Link>
        <span className="text-sm text-muted-foreground">{dateLabel}</span>
        <nav
          aria-label="Main"
          className="order-last -mx-1 flex w-full gap-1 overflow-x-auto pb-1 sm:order-none sm:w-auto sm:pb-0"
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.active ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                link.active && "bg-muted font-medium text-foreground",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <SyncNowButton />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="Account" />
              }
            >
              <UserRound aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  <span className="block truncate font-medium text-foreground">
                    {name}
                  </span>
                  <span className="block truncate text-xs font-normal">
                    {email}
                  </span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => startSignOut(async () => signOut())}
              >
                <LogOut aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

/** PRD 7.3: Sync now pulls the user's trackers straight away (once every 30 s). */
function SyncNowButton() {
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6_000);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        className={cn(
          "max-w-32 truncate text-xs sm:max-w-64",
          message?.ok === false ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message?.text}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        title={message?.text}
        onClick={() =>
          startTransition(async () => {
            const result = await syncNow();
            setMessage(
              result.ok
                ? { text: result.data.message, ok: true }
                : { text: result.error, ok: false },
            );
          })
        }
      >
        <RefreshCw aria-hidden className={cn(busy && "animate-spin")} />
        Sync now
      </Button>
    </div>
  );
}
