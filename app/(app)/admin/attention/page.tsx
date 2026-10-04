import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { ActionForm } from "@/components/admin/action-form";
import { DismissRequest } from "@/components/admin/dismiss-request";
import { NativeSelect, Section } from "@/components/admin/fields";
import { TrackerChip } from "@/components/tracker-chip";
import { buttonVariants } from "@/components/ui/button";
import {
  dismissTrackerRequest,
  linkOwnerName,
  mapStatusWord,
  retryWrites,
  setAttentionState,
} from "@/lib/actions/admin";
import {
  loadAdminTrackers,
  loadAttention,
  loadPeople,
  type AttentionItem,
} from "@/lib/admin/data";
import {
  attentionRow,
  describeAttention,
  groupAttention,
} from "@/lib/domain/attention";
import { USER_STATUSES } from "@/lib/domain/config";
import { STATUS_LABELS } from "@/lib/domain/status";
import { formatInstant } from "@/lib/time";

export const metadata: Metadata = { title: "Needs Attention · Knit" };

// PRD 12.8: grouped by tracker and kind; each item says what happened and where, with its
// actions: map status, link owner, dismiss, retry. A New tracker requested item (N86) offers
// Set up while its sheet is listed in the Knit folder, Open the sheet, and Dismiss with a
// reason.
export default async function AttentionPage() {
  const [items, people, admin] = await Promise.all([
    loadAttention(),
    loadPeople(),
    loadAdminTrackers(),
  ]);
  const users = people.users.filter((u) => u.is_active);
  // N86: the pick-tab page (11 step 2) opens only for a file admin_trackers lists.
  const listed = new Set(admin.files.map((f) => f.fileId));
  const groups = groupAttention(items);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Needs Attention</h1>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing needs attention.
        </p>
      ) : null}
      {groups.map((group) => (
        <Section
          key={group.tracker?.id ?? "knit"}
          title={group.tracker?.name ?? "Knit"}
          actions={
            group.tracker ? (
              <TrackerChip
                name={group.tracker.name}
                color={group.tracker.color}
              />
            ) : null
          }
        >
          <div className="flex flex-col gap-4">
            {group.kinds.map((kind) => (
              <div key={kind.kind}>
                <h3 className="mb-1 text-sm font-semibold">
                  {kind.title}{" "}
                  <span className="font-normal text-muted-foreground">
                    {kind.items.length}
                  </span>
                </h3>
                <ul className="flex flex-col divide-y">
                  {kind.items.map((item) => (
                    <Item
                      key={item.id}
                      item={item}
                      users={users}
                      listed={listed}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

function Item({
  item,
  users,
  listed,
}: {
  item: AttentionItem;
  users: { id: string; name: string }[];
  listed: ReadonlySet<string>;
}) {
  const row = attentionRow(item.detail, item.task?.rowHint ?? null);
  const sheetLink =
    item.tracker && row !== null
      ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(item.tracker.fileId)}/edit#gid=${item.tracker.gid}&range=A${row}`
      : null;
  const word = typeof item.detail.word === "string" ? item.detail.word : "";
  const name = typeof item.detail.name === "string" ? item.detail.name : "";

  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <p>{describeAttention(item.kind, item.detail, item.reporter)}</p>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{formatInstant(item.createdAt)}</span>
        {item.task ? (
          <Link
            href={`/tasks?everyone=1&task=${item.task.id}`}
            className="underline"
          >
            {item.task.title}
          </Link>
        ) : null}
        {sheetLink ? (
          <a
            href={sheetLink}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Row {row} in the sheet
          </a>
        ) : null}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {item.kind === "unmapped_status" && item.tracker ? (
          <ActionForm
            action={mapStatusWord.bind(null, item.id, item.tracker.id, word)}
            submitLabel="Map"
            submitVariant="outline"
            className="grid-cols-[12rem_auto] items-end"
          >
            <NativeSelect
              name="status"
              aria-label={`Knit status for ${word}`}
              defaultValue=""
            >
              <option value="">Choose a status</option>
              {USER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </ActionForm>
        ) : null}
        {item.kind === "unknown_owner" ? (
          <ActionForm
            action={linkOwnerName.bind(null, name, item.id)}
            submitLabel="Link"
            submitVariant="outline"
            className="grid-cols-[12rem_auto] items-end"
          >
            <NativeSelect
              name="user"
              aria-label={`Who is ${name}`}
              defaultValue=""
            >
              <option value="">Choose</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
              <option value="non_user">Not a Knit user</option>
            </NativeSelect>
          </ActionForm>
        ) : null}
        {(item.kind === "write_blocked" || item.kind === "row_not_found") &&
        item.task ? (
          <ActionButton action={retryWrites.bind(null, item.task.id)}>
            Retry
          </ActionButton>
        ) : null}
        {[
          "missing_header",
          "missing_tab",
          "missing_knit_id_column",
          "formula_column",
        ].includes(item.kind) && item.tracker ? (
          <Link
            href={`/admin/trackers/${item.tracker.id}`}
            className="text-sm font-medium underline"
          >
            Fix
          </Link>
        ) : null}
        {item.kind === "calendar_ending" ? (
          <Link
            href="/admin/holidays"
            className="text-sm font-medium underline"
          >
            Holidays
          </Link>
        ) : null}
        {item.kind === "tracker_request" ? (
          <TrackerRequestActions item={item} listed={listed} />
        ) : (
          <ActionButton
            action={setAttentionState.bind(null, item.id, "dismissed")}
            variant="ghost"
          >
            Dismiss
          </ActionButton>
        )}
      </div>
    </li>
  );
}

/**
 * N86, 12.8: Set up (11 step 2 for the sheet) only while the sheet is listed in the Knit
 * folder, Open the sheet, and Dismiss with a reason the person sees.
 */
function TrackerRequestActions({
  item,
  listed,
}: {
  item: AttentionItem;
  listed: ReadonlySet<string>;
}) {
  const fileId =
    typeof item.detail.fileId === "string" ? item.detail.fileId : "";
  const requestId = Number(item.detail.requestId);
  return (
    <>
      {listed.has(fileId) ? (
        <Link
          href={`/admin/trackers/new/${encodeURIComponent(fileId)}`}
          className={buttonVariants({ size: "sm" })}
        >
          Set up
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground">
          The sheet is no longer in the Knit folder.
        </span>
      )}
      {fileId !== "" ? (
        <a
          href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium underline"
        >
          Open the sheet
        </a>
      ) : null}
      {Number.isInteger(requestId) && requestId > 0 ? (
        <DismissRequest
          action={dismissTrackerRequest.bind(null, requestId)}
          requester={item.reporter ?? "The person"}
        />
      ) : null}
    </>
  );
}
