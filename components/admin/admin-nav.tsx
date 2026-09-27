"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// PRD 12.1: the admin screens.
const LINKS = [
  { href: "/admin/trackers", label: "Trackers" },
  { href: "/admin/sync", label: "Sync health" },
  { href: "/admin/attention", label: "Needs Attention" },
  { href: "/admin/people", label: "People" },
  { href: "/admin/holidays", label: "Holidays" },
];

export function AdminNav({ attention }: { attention: number }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Admin"
      className="-mx-1 flex gap-1 overflow-x-auto border-b pb-2"
    >
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
              active && "bg-muted font-medium text-foreground",
            )}
          >
            {link.label}
            {link.href === "/admin/attention" && attention > 0 ? (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-xs text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
                {attention}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
