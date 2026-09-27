"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";

/**
 * D2, PRD 12.3: Blocked and Cancelled need a one-line reason; Cancelled also asks for
 * confirmation.
 */
export function ReasonDialog({
  status,
  onClose,
  onConfirm,
}: {
  status: "blocked" | "cancelled" | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const cancelling = status === "cancelled";
  const trimmed = reason.trim();

  return (
    <Dialog
      open={status !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            setReason("");
            onConfirm(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {cancelling ? "Cancel this task?" : "Why is it blocked?"}
            </DialogTitle>
            {cancelling ? (
              <DialogDescription>
                This removes it from all future days
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={id}>Reason</Label>
            <Input
              id={id}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX_LENGTH}
              required
              autoFocus
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Back
            </Button>
            <Button
              type="submit"
              variant={cancelling ? "destructive" : "default"}
              disabled={trimmed === ""}
            >
              {cancelling ? "Cancel task" : "Mark blocked"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
