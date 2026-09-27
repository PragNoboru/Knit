"use client";

import { useRouter } from "next/navigation";

import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * PRD 12.6, D8: the read-only side drawer. It is open while the URL has ?task=<id>; closing
 * it removes the param and keeps the page where it was.
 */
export function TaskDrawer({
  closeHref,
  children,
}: {
  closeHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.replace(closeHref, { scroll: false });
      }}
    >
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {children}
      </SheetContent>
    </Sheet>
  );
}
