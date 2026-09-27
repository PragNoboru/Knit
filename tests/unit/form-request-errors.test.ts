import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActionForm } from "@/components/admin/action-form";
import { LoginForm } from "@/components/login-form";
import { TopBar } from "@/components/top-bar";
import type { FormState } from "@/lib/actions/admin";
import { signIn, signOut } from "@/lib/actions/auth";
import { NETWORK_ERROR } from "@/lib/errors";

// N48, PRD 14 (review R15): a request that never reaches the server shows "Knit couldn't reach
// the server" under the form or menu that sent it, in every admin form, the sign-in form and
// Sign out, instead of replacing the page with the error page. An error the server threw still
// reaches the error page with its retry (review R12).

const hooks = vi.hoisted(() => ({
  action: null as ((state: unknown, form: FormData) => Promise<unknown>) | null,
  transition: null as Promise<void> | null,
  setState: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: (
      action: (state: unknown, form: FormData) => Promise<unknown>,
      initial: unknown,
    ) => {
      hooks.action = action;
      return [initial, () => undefined, false];
    },
    useTransition: () => [
      false,
      (run: () => Promise<void>) => {
        hooks.transition = run();
      },
    ],
    useState: (initial: unknown) => [initial, hooks.setState],
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/",
}));
vi.mock("@/lib/actions/auth", () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/actions/tasks", () => ({ syncNow: vi.fn() }));

const offline = (): Promise<FormState> =>
  Promise.reject(new TypeError("Failed to fetch"));
const serverFault = (): Promise<FormState> =>
  Promise.reject(new Error("app_users read failed"));

type Props = { children?: ReactNode; onClick?: () => void };

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

beforeEach(() => {
  hooks.action = null;
  hooks.transition = null;
  hooks.setState.mockClear();
});

describe("ActionForm (every admin form)", () => {
  it("shows a request that never reached the server under the form", async () => {
    const action = vi.fn(offline);
    ActionForm({ action, submitLabel: "Save" });
    expect(await hooks.action!({ error: null }, new FormData())).toEqual({
      error: NETWORK_ERROR,
    });
    action.mockImplementationOnce(async () => ({
      error: null,
      notice: "Saved.",
    }));
    expect(await hooks.action!({ error: null }, new FormData())).toEqual({
      error: null,
      notice: "Saved.",
    });
  });

  it("leaves an error the server threw to the error page with retry (PRD 14)", async () => {
    ActionForm({ action: serverFault, submitLabel: "Save" });
    await expect(
      hooks.action!({ error: null }, new FormData()),
    ).rejects.toThrow("app_users read failed");
  });
});

describe("the sign-in form", () => {
  it("shows a request that never reached the server under the form", async () => {
    vi.mocked(signIn).mockImplementationOnce(offline);
    LoginForm({ next: undefined, notice: null });
    expect(await hooks.action!({ error: null }, new FormData())).toEqual({
      error: NETWORK_ERROR,
    });
  });
});

describe("Sign out in the top bar", () => {
  it("shows a request that never reached the server in the bar", async () => {
    vi.mocked(signOut).mockImplementationOnce(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const tree = TopBar({
      dateLabel: "Mon 28 Sep",
      name: "Asha",
      email: "asha@knit.test",
      isAdmin: false,
    });
    const item = find(
      tree,
      (e) =>
        Array.isArray(e.props.children) &&
        e.props.children.includes("Sign out") &&
        typeof e.props.onClick === "function",
    );
    item!.props.onClick!();
    await hooks.transition;
    expect(hooks.setState).toHaveBeenLastCalledWith(NETWORK_ERROR);
  });
});
