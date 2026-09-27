"use client";

import { useId, useState, useTransition } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { correctTaskDay, reportIssue } from "@/lib/actions/tasks";
import { USER_STATUSES, type UserStatus } from "@/lib/domain/config";
import { REASON_MAX_LENGTH, STATUS_LABELS } from "@/lib/domain/status";

/** PRD 6.10, 12.6: the admin's Request correction on a locked task-day. */
export function CorrectionButton({
  taskDayId,
  dayLabel,
}: {
  taskDayId: number;
  dayLabel: string;
}) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UserStatus>("done");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="xs" />}>
        Request correction
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await correctTaskDay({
                taskDayId,
                status,
                reason,
              });
              if (!result.ok) setError(result.error);
              else {
                setReason("");
                setOpen(false);
              }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Correct {dayLabel}</DialogTitle>
            <DialogDescription>
              Done or Cancelled also closes every later day of this task.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>New status</Label>
            <Select
              value={status}
              onValueChange={(value) => value && setStatus(value as UserStatus)}
            >
              <SelectTrigger aria-label="New status" className="w-full">
                <SelectValue>
                  {(value: UserStatus) => <StatusBadge status={value} />}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {USER_STATUSES.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    label={STATUS_LABELS[option]}
                  >
                    <StatusBadge status={option} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={reasonId}>Reason</Label>
            <Input
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX_LENGTH}
              required
              autoComplete="off"
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Back
            </Button>
            <Button type="submit" disabled={busy || reason.trim() === ""}>
              Save correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** PRD 12.6: a member's Report an issue, which reaches the admin's Needs Attention queue. */
export function ReportIssueButton({
  taskDayId,
  dayLabel,
}: {
  taskDayId: number;
  dayLabel: string;
}) {
  const textId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  if (sent)
    return (
      <span className="text-xs text-muted-foreground">Sent to the admin</span>
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="xs" />}>
        Report an issue
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              setError(null);
              const result = await reportIssue({ taskDayId, text });
              if (!result.ok) setError(result.error);
              else {
                setOpen(false);
                setSent(true);
              }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Report an issue with {dayLabel}</DialogTitle>
            <DialogDescription>
              The admin sees this and can correct the day.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={textId}>What is wrong?</Label>
            <Textarea
              id={textId}
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={500}
              required
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Back
            </Button>
            <Button type="submit" disabled={busy || text.trim() === ""}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
