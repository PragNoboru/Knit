"use client";

import { useId, useMemo, useState } from "react";

import { ActionForm } from "@/components/admin/action-form";
import { announcing, useAnnounce } from "@/components/admin/attention-notice";
import { Field, TextInput } from "@/components/admin/fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FormState } from "@/lib/actions/admin";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";

/**
 * PRD N86, 12.8: Dismiss on a New tracker requested item asks for a one-line reason (D2),
 * which the person who sent the sheet sees with their request. The rules are the action's.
 */
export function DismissRequest({
  action,
  requester,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  requester: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // "Request dismissed." outlives this dialog: the refresh removes the item (12.8).
  const announce = useAnnounce();
  const dismiss = useMemo(
    () => announcing(action, announce),
    [action, announce],
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Dismiss
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss this request</DialogTitle>
          </DialogHeader>
          <ActionForm action={dismiss} submitLabel="Dismiss request">
            <Field
              label="Reason"
              htmlFor={id}
              hint={`One line. ${requester} sees it with their request.`}
            >
              <TextInput
                id={id}
                name="reason"
                maxLength={REASON_MAX_LENGTH}
                autoComplete="off"
                autoFocus
              />
            </Field>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
