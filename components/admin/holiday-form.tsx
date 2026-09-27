"use client";

import { useRef, useState, useTransition } from "react";

import { Field, TextInput } from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/actions/admin";
import { callVoidAction } from "@/lib/actions/call";

/**
 * PRD 12.8, N19(g): add a holiday. When the date has open tasks, Knit first says how many; only
 * then does a box appear to confirm that number, and the server saves only if the number is
 * still right. The date and name stay filled in meanwhile.
 */
export function HolidayForm({
  action,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<FormState>({ error: null });
  const [pending, startTransition] = useTransition();
  const tasks = (n: number) => `${n} open ${n === 1 ? "task" : "tasks"}`;

  return (
    <form
      ref={formRef}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await callVoidAction(() => action(state, form));
          const next = result.ok ? result.value : { error: result.error };
          setState(next);
          if (next.error === null && next.confirm === undefined)
            formRef.current?.reset();
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Date" htmlFor="day">
          <TextInput id="day" name="day" type="date" required />
        </Field>
        <Field label="Name" htmlFor="holiday-name">
          <TextInput id="holiday-name" name="name" required maxLength={80} />
        </Field>
        {state.confirm !== undefined ? (
          <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
            <input
              type="checkbox"
              name="confirm"
              value={String(state.confirm)}
              required
              className="size-4 accent-foreground"
            />
            Recompute the {tasks(state.confirm)} on this date
          </label>
        ) : null}
      </div>
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
        <Button type="submit" disabled={pending}>
          Save holiday
        </Button>
      </div>
    </form>
  );
}
