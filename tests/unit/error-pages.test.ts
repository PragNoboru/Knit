import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import RootError from "@/app/error";
import AppError from "@/app/(app)/error";

// PRD 14 (audit finding 31): "UI error page with retry". Try again must re-fetch (Next.js
// `retry`), and a failure in the (app) layout itself must still reach a Knit error page.

type Props = { children?: ReactNode; onClick?: () => void };

/** Walks a rendered tree (calling plain function components) to the first match. */
function find(
  node: ReactNode,
  match: (element: ReactElement<Props>) => boolean,
): ReactElement<Props> | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  const element = node as ReactElement<Props>;
  if (match(element)) return element;
  if (typeof element.type === "function")
    return find(
      (element.type as (props: Props) => ReactNode)(element.props),
      match,
    );
  return find(element.props.children, match);
}

const tryAgain = (element: ReactElement<Props>) =>
  element.props.children === "Try again" &&
  typeof element.props.onClick === "function";

describe.each([
  ["app/(app)/error.tsx", AppError],
  ["app/error.tsx, for errors in the (app) layout", RootError],
])("%s", (_name, Page) => {
  it("shows the Knit copy, and Try again re-fetches the page", () => {
    const retry = vi.fn();
    const tree = Page({ error: new Error("app_users read failed"), retry });
    const button = find(tree, tryAgain);
    expect(button).not.toBeNull();
    expect(
      find(tree, (e) => e.props.children === "Knit can't load this page"),
    ).not.toBeNull();
    button!.props.onClick!();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
