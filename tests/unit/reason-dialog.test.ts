import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReasonDialog } from "@/components/reason-dialog";

// D2, PRD 12.3 (audit finding 57): Back clears the reason, so a reason typed for Cancelled
// never pre-fills the Blocked question that follows.

const reason = vi.hoisted(() => ({ value: "", set: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useId: () => "reason",
    useState: () => [reason.value, reason.set],
  };
});

type Props = {
  children?: ReactNode;
  onClick?: () => void;
  onOpenChange?: (open: boolean) => void;
};

/** Finds an element in the tree as written, without rendering any component. */
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
  return match(element) ? element : find(element.props.children, match);
}

describe("ReasonDialog", () => {
  beforeEach(() => {
    reason.value = "Duplicate of G12";
    reason.set.mockClear();
  });

  it("Back clears the reason before closing", () => {
    const onClose = vi.fn();
    const tree = ReasonDialog({
      status: "cancelled",
      onClose,
      onConfirm: vi.fn(),
    });
    const back = find(tree, (e) => e.props.children === "Back");
    back!.props.onClick!();
    expect(reason.set).toHaveBeenCalledWith("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape or a click outside clears it too", () => {
    const onClose = vi.fn();
    const tree = ReasonDialog({
      status: "blocked",
      onClose,
      onConfirm: vi.fn(),
    }) as ReactElement<Props>;
    tree.props.onOpenChange!(false);
    expect(reason.set).toHaveBeenCalledWith("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
