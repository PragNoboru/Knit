"use client";

import { useActionState, useState } from "react";

import { Field, TextInput } from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { withRequestErrors } from "@/lib/actions/call";
import {
  requestTracker,
  type RequestFormState,
} from "@/lib/actions/tracker-requests";
import { NOTE_MAX_LENGTH, REQUEST_COPY } from "@/lib/domain/tracker-request";

/**
 * PRD N83 to N85, 12.9: "Send a sheet to the admin" on the Guide. The checks and every
 * sentence are the action's (lib/actions/tracker-requests.ts); this only shows them. The fields
 * keep what was typed after a refusal, so the person can fix the sheet and press again, and
 * clear once the sheet is sent.
 */
export function TrackerRequestForm() {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [state, formAction, pending] = useActionState(
    async (previous: RequestFormState, form: FormData) => {
      const next = await withRequestErrors(
        requestTracker,
        (error): RequestFormState => ({ error }),
      )(previous, form);
      if (next.sent) {
        setUrl("");
        setNote("");
      }
      return next;
    },
    { error: null },
  );

  return (
    <form
      action={formAction}
      aria-label={REQUEST_COPY.heading}
      className="grid gap-4"
    >
      <Field
        label={REQUEST_COPY.linkLabel}
        htmlFor="request-url"
        hint={REQUEST_COPY.linkHint}
      >
        <TextInput
          id="request-url"
          name="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://docs.google.com/spreadsheets/d/..."
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field
        label={REQUEST_COPY.noteLabel}
        htmlFor="request-note"
        hint={REQUEST_COPY.noteHint}
      >
        <Textarea
          id="request-note"
          name="note"
          rows={2}
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {state.error ? (
        <div role="alert" className="grid gap-1 text-sm text-destructive">
          <p>{state.error}</p>
          {state.problems && state.problems.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {state.problems.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.notice ? (
        <div role="status" className="grid gap-1 text-sm text-foreground">
          <p className="font-medium">{state.notice}</p>
          {(state.sent ?? []).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? REQUEST_COPY.pending : REQUEST_COPY.submit}
        </Button>
      </div>
    </form>
  );
}
