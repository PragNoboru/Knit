import { ExternalLink } from "lucide-react";

import { ActionForm } from "@/components/admin/action-form";
import { Field, TextInput } from "@/components/admin/fields";
import { buttonVariants } from "@/components/ui/button";
import { saveTemplateLink } from "@/lib/actions/admin";
import { ATTENTION_TITLES } from "@/lib/domain/attention";
import type { UserStatus } from "@/lib/domain/config";
import {
  GROUP_ORDER,
  TODAY_TITLES,
  type GroupKey,
} from "@/lib/domain/day-view";
import { TEMPLATE_LINK_COPY, type TemplateLink } from "@/lib/domain/guide";
import {
  KNIT_STANDARD_V2,
  STANDARD_BUTTON,
  standardHeading,
} from "@/lib/domain/standard-template";
import { STATUS_LABELS } from "@/lib/domain/status";
import { WIZARD_STEPS, type WizardStep } from "@/lib/domain/wizard";
import { formatDay } from "@/lib/time";

/**
 * PRD 12.9 (N77 to N82): how to use Knit, as static text. Labels the app defines elsewhere
 * (status labels, Today's groups, wizard steps, Needs Attention titles, the template's headers)
 * are read from the modules that define them, so the Guide cannot drift from the screens (N79).
 * The admin sections are rendered only when `isAdmin`, on the server: a member's page never
 * holds them (N77).
 */

interface GuideProps {
  isAdmin: boolean;
  /** N80: the saved template link, or null when none is saved. */
  template: TemplateLink | null;
}

interface GuideSection {
  id: string;
  title: string;
  body: (props: GuideProps) => React.ReactNode;
}

/** A label as the app shows it. */
function L({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5">{children}</ul>;
}

function Steps({ children }: { children: React.ReactNode }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5">{children}</ol>
  );
}

const step = (key: WizardStep) =>
  WIZARD_STEPS.find((s) => s.step === key)?.title ?? key;

const attention = (kind: string) => ATTENTION_TITLES[kind] ?? kind;

/** 12.3: an open-ended task's label on Today, as `dueLabel` writes it. */
const OPEN_ENDED_EXAMPLE = `From ${formatDay("2026-10-30")}`;

/** 12.3: what each group of Today holds, in Today's order. */
const GROUP_TEXT: Record<GroupKey, string> = {
  spillover:
    "tasks from an earlier day that were not finished. The red badge says how often the task spilled and its first due date.",
  due: "tasks due today.",
  ongoing: `tasks that run over several days, between their first and last day, and open-ended tasks (${OPEN_ENDED_EXAMPLE}). On its due date (its last working day) a task moves to Due today.`,
  pulled_forward: "later tasks you set to In Progress to start them early.",
  blocked: "today's blocked tasks, with their reason.",
  done: "today's done and cancelled tasks, and tasks finished early today (tagged early). It starts folded; press it to open.",
};

/** 6.1, D2: when to use each status a person can pick. */
const STATUS_TEXT: Record<UserStatus, string> = {
  yet_to_start: "not begun yet.",
  in_progress:
    "you have started. On a later task this pulls it forward onto Today.",
  blocked:
    "you cannot go on until something else happens. Knit asks why in one line; the reason shows on the task and in the sheet. A blocked task is not a miss, but it moves to the next working day until it is unblocked.",
  done: "finished. Done on a later task counts as done early, today.",
  cancelled:
    "no longer needed. Knit asks for a reason and to confirm, because it removes the task from all future days.",
};

const USER_STATUS_ORDER: readonly UserStatus[] = [
  "yet_to_start",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

/** N81: the template's five Status words, as the sheet spells them (not Knit's labels). */
const SHEET_STATUS_WORDS = USER_STATUS_ORDER.map(
  (s) => KNIT_STANDARD_V2.statusWords[s],
).join(", ");

function TemplateLinkLine({ isAdmin, template }: GuideProps) {
  if (template)
    return (
      <a
        href={template.copyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ size: "sm" })}
      >
        <ExternalLink aria-hidden />
        {TEMPLATE_LINK_COPY.get}
      </a>
    );
  return (
    <p className="font-medium text-foreground">
      {isAdmin ? TEMPLATE_LINK_COPY.noneYet : TEMPLATE_LINK_COPY.askAdmin}
    </p>
  );
}

const EVERYONE: readonly GuideSection[] = [
  {
    id: "what-knit-is",
    title: "What Knit is",
    body: () => (
      <>
        <p>
          Knit gathers the tasks of the team&apos;s Google Sheet trackers into
          one daily list. It shows what is due today across every tracker, lets
          you change a task&apos;s status in one place, and writes that status
          back to the sheet.
        </p>
        <p>
          Tasks are planned in the sheets. Titles, dates and people are changed
          there, never in Knit. You see the tasks assigned to you.
        </p>
      </>
    ),
  },
  {
    id: "today",
    title: "Today",
    body: () => (
      <>
        <p>
          The heading shows the date, how many of today&apos;s tasks are done
          and how many spilled in from earlier days, for example &quot;Mon 5 Oct
          · 4 of 9 done · 2 spilled in&quot;. Tasks are grouped in this order,
          and an empty group is hidden:
        </p>
        <List>
          {GROUP_ORDER.map((key) => (
            <li key={key}>
              <L>{TODAY_TITLES[key]}</L>: {GROUP_TEXT[key]}
            </li>
          ))}
        </List>
        <p>
          In each group critical tasks (a flame) come first, then by due date.
          Each row shows its tracker, its due date, its status and{" "}
          <L>Open in sheet</L> (the arrow icon), which opens the task&apos;s
          row. Narrow the list with <L>Trackers</L> and <L>Status</L> at the
          top.
        </p>
        <p>
          Banners at the top say when a tracker is paused (Knit then shows its
          last data and the time it was read) and, after 17:30, how many of
          today&apos;s tasks are still open and the day they move to.
        </p>
      </>
    ),
  },
  {
    id: "day-and-calendar",
    title: "Day view and Calendar",
    body: () => (
      <>
        <p>
          On Today, the arrows beside the date open the day before and the day
          after. A day looks like Today; <L>Today</L> brings you back. A past
          day is closed: a lock shows and its statuses cannot change. A later
          day can be changed, which is how you start a task early.
        </p>
        <p>
          <L>Calendar</L> shows a month, Monday first. Pick a date to see its
          tasks below. Each date is coloured:
        </p>
        <List>
          <li>green: every task that day was done or cancelled;</li>
          <li>
            red: a closed day with a task marked {STATUS_LABELS.not_done};
          </li>
          <li>
            amber: today or a later day with open work, or an earlier day not
            closed yet or holding a {STATUS_LABELS.blocked} task;
          </li>
          <li>
            grey stripes: a day off (point at it to see why: Sunday, 2nd
            Saturday, a holiday);
          </li>
          <li>blank: a working day with nothing on it.</li>
        </List>
      </>
    ),
  },
  {
    id: "all-tasks",
    title: "All Tasks and the task drawer",
    body: () => (
      <>
        <p>
          <L>All Tasks</L> lists all your tasks, 50 a page. Filter with{" "}
          <L>Search titles</L>, <L>From</L>, <L>To</L>, <L>Tracker</L> and{" "}
          <L>Status</L>, then <L>Apply</L>; <L>Clear</L> starts again. Use it to
          look a task up, or to set a later task to In Progress and start it
          early.
        </p>
        <p>
          Press a task&apos;s title to open its drawer: its source ID, the
          planned date as the sheet writes it, the due date, Owner and Maker,
          its details, <L>Open in sheet</L>, the days it was on (a lock marks a
          closed day) and its history: who changed what, in Knit or in the
          sheet, and when. The drawer only shows; change the task&apos;s content
          in the sheet.
        </p>
      </>
    ),
  },
  {
    id: "statuses",
    title: "Statuses",
    body: () => (
      <>
        <p>Pick one of five statuses from the task&apos;s status menu:</p>
        <List>
          {USER_STATUS_ORDER.map((status) => (
            <li key={status}>
              <L>{STATUS_LABELS[status]}</L>: {STATUS_TEXT[status]}
            </li>
          ))}
        </List>
        <p>
          <L>{STATUS_LABELS.not_done}</L> is set only by Knit, on a day that
          closed with the task unfinished. A status set today can be changed
          again until midnight. Just after midnight a task still on yesterday
          waits a few minutes for yesterday&apos;s close.
        </p>
      </>
    ),
  },
  {
    id: "reaching-the-sheet",
    title: "How a change reaches the sheet",
    body: () => (
      <>
        <p>
          When you change a status, Knit writes it to the tracker&apos;s Status
          cell, sets Done on when you mark it Done (and clears it when you
          change it back), and updates the Knit Note. A small <L>Syncing</L>{" "}
          pill shows until the change is in the sheet, usually within seconds.
          If Knit cannot write it after several tries, the pill turns amber,{" "}
          <L>Not saved to sheet</L>, and the admin sees why in Needs Attention
          and can retry it.
        </p>
        <p>
          A change made in the sheet reaches Knit within 10 minutes, or at once
          with <L>Sync now</L>. Knit writes only four cells of a row: the
          status, Done on, the Knit Note and the hidden Knit ID. It never
          changes a title, a date or a name, and never deletes a row. When Knit
          and the sheet were both changed, Knit keeps its status and tells the
          admin.
        </p>
      </>
    ),
  },
  {
    id: "knit-note",
    title: "The Knit Note",
    body: () => (
      <>
        <p>
          Every tracker has a <L>Knit Note</L> column at the far right that Knit
          keeps up to date, so the sheet shows where each task stands in Knit.
          For example:
        </p>
        <List>
          <li>Spilled 2x · now due Tue 6 Oct</li>
          <li>Blocked: waiting for the copy</li>
          <li>Done on Mon 5 Oct · after 1 spill</li>
          <li>Done early on Thu 1 Oct · planned Mon 5 Oct</li>
          <li>Cancelled: not needed this month</li>
          <li>Before Knit go-live</li>
        </List>
        <p>
          Never type in the Knit Note: Knit writes over it. Never edit, sort
          into or delete the hidden <L>Knit ID</L> column either; it is how Knit
          finds each row.
        </p>
      </>
    ),
  },
  {
    id: "spillover",
    title: "Spillover and the midnight close",
    body: () => (
      <>
        <p>
          Each day closes at midnight India time (IST). A task done by 23:59
          counts for that day. At the close:
        </p>
        <List>
          <li>Done and Cancelled tasks are kept as they are.</li>
          <li>
            Yet to Start and In Progress tasks become{" "}
            <L>{STATUS_LABELS.not_done}</L> on that day, and appear on the next
            working day under <L>{TODAY_TITLES.spillover}</L> with their status.
          </li>
          <li>
            Blocked tasks stay Blocked on that day and move to the next working
            day with their reason.
          </li>
        </List>
        <p>
          This repeats every day until the task is done or cancelled, so nothing
          due disappears. A task you started early never spills before its own
          date. The date in the sheet never changes; the Knit Note says where
          the task is now. A closed day cannot be changed: if it is wrong, use
          Report an issue.
        </p>
      </>
    ),
  },
  {
    id: "owner-and-maker",
    title: "Owner and Maker",
    body: () => (
      <>
        <p>
          In the Knit tracker template, <L>Maker</L> is who does the task and{" "}
          <L>Owner</L> is who checks that it is done. A task reaches the Today
          of the people named in Maker, or in Owner when Maker is blank. Either
          can name several people, separated by commas.
        </p>
        <p>
          The task shows &quot;Owner: names&quot; and its drawer lists Owner and
          Maker. A step for the Owner to confirm the work or send it back comes
          in a later version.
        </p>
      </>
    ),
  },
  {
    id: "sync-now",
    title: "Sync now",
    body: () => (
      <p>
        <L>Sync now</L> in the top bar reads your trackers again at once, so a
        change made in the sheet shows without waiting up to 10 minutes. You can
        press it once every 30 seconds. It says &quot;Up to date.&quot; when it
        is done.
      </p>
    ),
  },
  {
    id: "report-an-issue",
    title: "Report an issue",
    body: () => (
      <p>
        When a closed day is wrong (say a task shows Not Done but you finished
        it that day), open the task, find the day under <L>Days</L> and press{" "}
        <L>Report an issue</L>. Say what is wrong and press <L>Send</L>. The
        admin sees it in Needs Attention and can correct the day.
      </p>
    ),
  },
  {
    id: "working-days",
    title: "Working days and holidays",
    body: () => (
      <p>
        Working days are Monday to Friday and the 1st and 3rd Saturday of the
        month, except holidays. Sundays and the other Saturdays are off. A task
        planned on a day off is due on the working day before it, unless its
        tracker is set otherwise. Spillovers skip days off. The admin keeps the
        list of holidays; Calendar shows each one striped, with its name.
      </p>
    ),
  },
  {
    id: "new-tracker",
    title: "Add a new tracker",
    body: (props) => (
      <>
        <p>
          Knit reads only Google Sheets in the Knit folder. You cannot upload a
          file into Knit, and an uploaded Excel file is not read. To start a new
          tracker:
        </p>
        <Steps>
          <li>
            Make a copy of the tracker template. The copy goes to your own
            Google Drive; give it a clear name, such as the brand and the
            project.
          </li>
          <li>
            Fill the Tasks tab in the template&apos;s format (its Guide tab
            explains it): one task per row, a real date in Date, Status picked
            from its dropdown ({SHEET_STATUS_WORDS}), each name spelt the same
            way every time. Keep row 1 as it is.
          </li>
          <li>
            Share the sheet with the admin and tell them. The admin moves it
            into the Knit folder (or move it yourself, if you can edit that
            folder).
          </li>
          <li>
            The admin connects it. Its tasks then reach the Today of the people
            named in it.
          </li>
        </Steps>
        <p>
          Never start from a copy of a tracker that is already in Knit: its
          hidden Knit IDs would come along. Always start from the template.
        </p>
        <TemplateLinkLine {...props} />
      </>
    ),
  },
];

const ADMIN: readonly GuideSection[] = [
  {
    id: "connect-a-tracker",
    title: "Connect a tracker",
    body: () => (
      <>
        <Steps>
          <li>
            Put the sheet in the Knit folder as a Google Sheet and press{" "}
            <L>Sync now</L>, or wait up to 10 minutes. Admin &gt; Trackers lists
            it under <L>New sheet found</L>. <L>Ignore</L> hides a sheet that is
            not a tracker.
          </li>
          <li>
            Press <L>Set up</L>, then <L>Use this tab</L> on the Tasks tab.
          </li>
          <li>
            {step("header")}: when row 1 holds the template&apos;s columns, Knit
            says &quot;{standardHeading(KNIT_STANDARD_V2)}&quot; Press{" "}
            <L>{STANDARD_BUTTON}</L>: it fills the columns, statuses and
            write-back words in one go. No button means a header was renamed,
            moved, doubled or left out, or Status or Done on holds formulas: fix
            the sheet, or set it up step by step.
          </li>
          <li>
            {step("owners")}: link each name Knit does not know to a person, or
            mark it Not a Knit user, and choose whose rows reach Today (next
            section).
          </li>
          <li>
            {step("details")}: the name and colour shown on every task. Go-live
            defaults to the next working day; rows due before it are history
            only.
          </li>
          <li>
            {step("preview")}, then <L>{step("activate")}</L>. Knit adds the
            hidden Knit ID column and the Knit Note column, writes an ID on
            every row and reads the tracker. When old rows are still open, the
            backlog review opens.
          </li>
        </Steps>
        <p>
          <L>Set up another tab</L> connects a second tab of the same
          spreadsheet as its own tracker.
        </p>
      </>
    ),
  },
  {
    id: "whose-rows",
    title: "Whose rows reach Today",
    body: () => (
      <>
        <p>
          At {step("owners")}, <L>Whose rows reach Today</L> has two choices:
        </p>
        <List>
          <li>
            <L>Only rows naming the person</L>: a task reaches only the people
            with a Knit login named in its Maker, or in Owner when Maker is
            blank. A task for someone without a login reaches nobody&apos;s
            Today; you still find it in All Tasks with <L>Everyone</L>.
          </li>
          <li>
            <L>Every row, also to the tracker owner</L>: the same, and every row
            also reaches the tracker owner, the admin who set it up. Use it
            while you are the only Knit user, so tasks made by people without a
            login still reach you.
          </li>
        </List>
        <p>Change it later with Edit mapping.</p>
      </>
    ),
  },
  {
    id: "people",
    title: "People",
    body: () => (
      <>
        <p>Admin &gt; People:</p>
        <List>
          <li>
            <L>Add a user</L>: Name, Email, Role (Member or Admin), a Password
            of at least 8 characters, and <L>Name in trackers</L>, the name as
            the sheets spell it (for example Shlok). Press <L>Create user</L>{" "}
            and tell them the password yourself: there is no sign-up.
          </li>
          <li>
            A name marked Not a Knit user can become a person: create their
            login with that name in Name in trackers. Knit links the name to
            them and reads the trackers again; from then on (at once, or within
            10 minutes) their tasks reach their Today, with their history. If
            the name is already linked to someone else, it moves to the new
            person, and so do its tasks.
          </li>
          <li>
            <L>Names in trackers</L> links a name to an existing person, or
            marks it Not a Knit user: type the name as the trackers write it,
            choose the Person, then <L>Save name</L>. Each spelling is its own
            name (Shlok and Shlok K).
          </li>
          <li>
            <L>Reset</L> sets a new password (<L>Set password</L>). People
            cannot change their own password in Knit.
          </li>
          <li>
            <L>Deactivate</L> stops a person signing in at once; <L>Activate</L>{" "}
            lets them back. You cannot deactivate yourself.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "needs-attention",
    title: "Needs Attention",
    body: () => (
      <>
        <p>
          Admin &gt; Needs Attention lists what Knit would not decide on its
          own, by tracker. Each item says what happened, with a link to the row.
          Its actions: <L>Map</L> a status word, <L>Link</L> a name to a person
          (or Not a Knit user), <L>Retry</L> a write, <L>Fix</L> on the
          tracker&apos;s page, and <L>Dismiss</L> once it is dealt with. The
          usual ones:
        </p>
        <List>
          <li>
            <L>{attention("unmapped_status")}</L>: its rows count as Yet to
            Start until you map the word.
          </li>
          <li>
            <L>{attention("unknown_owner")}</L>: one per name; link it or mark
            it Not a Knit user.
          </li>
          <li>
            <L>{attention("bad_date")}</L>: fix the cell; the task keeps its
            last good dates.
          </li>
          <li>
            <L>{attention("conflict")}</L>: the sheet shows a different status
            from Knit (both were changed, the check at the day&apos;s close
            found it, or the sheet reopened a finished task); Knit kept its own
            status.
          </li>
          <li>
            <L>{attention("missing_header")}</L>: the tracker is paused; put the
            column back, then press <L>Resume</L> on the tracker&apos;s page.
          </li>
          <li>
            <L>{attention("member_report")}</L>: correct the day if it is wrong.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "sync-health",
    title: "Sync health",
    body: () => (
      <p>
        Admin &gt; Sync health shows the <L>Write-backs</L> by state, with{" "}
        <L>Retry failed</L>; the <L>Day closes</L> of the last 14 days with
        their counts and errors, and how far the working-day calendar reaches;
        and the <L>Last 50 runs</L> of Knit&apos;s jobs. Look here when Today
        says &quot;Yesterday is not closed yet. Check Sync health.&quot;
      </p>
    ),
  },
  {
    id: "holidays",
    title: "Holidays",
    body: () => (
      <p>
        Admin &gt; Holidays: give the Date and Name, then <L>Save holiday</L>.
        When open tasks are on that date, Knit says how many and asks you to
        tick the box and save again; their due dates are worked out again.{" "}
        <L>Remove</L> takes a holiday off. Closed days never change. Before the
        working-day calendar runs out (Sync health warns 60 days ahead), add
        next year&apos;s holidays and press <L>Extend by a year</L>.
      </p>
    ),
  },
  {
    id: "edit-mapping",
    title: "Edit mapping",
    body: () => (
      <p>
        Admin &gt; Trackers, the tracker, then <L>Edit mapping</L> opens the
        setup steps for a live tracker. {step("details")} changes its name and
        colour; {step("owners")} changes whose rows reach Today. Saving checks
        the tab and reads it again. History never changes: a word given another
        Knit status changes only new rows and rows that change to it from now
        on. The go-live date is fixed once the tracker is live.
      </p>
    ),
  },
  {
    id: "pause-resume-archive",
    title: "Pause, Resume, Archive",
    body: () => (
      <>
        <p>
          On a tracker&apos;s page, <L>Sync now</L> reads it at once.{" "}
          <L>Pause</L> stops syncing it: its tasks stay visible and status
          changes wait. <L>Resume</L> checks that the sheet is in the Knit
          folder and its columns match, then sends the changes that waited.{" "}
          <L>Archive</L> stops it for good; its history stays.
        </p>
        <p>
          Knit pauses a tracker itself when a column it reads is renamed or
          deleted or appears twice, when the Knit ID or Knit Note column is
          missing, when a column Knit writes (Status, Done on, Knit ID, Knit
          Note) starts holding formulas, or when the sheet leaves the Knit
          folder. Put it right in the sheet (File &gt; Version history helps),
          then Resume. For a lost Knit ID column, the tracker&apos;s page also
          offers <L>Recreate the Knit ID column</L>.
        </p>
      </>
    ),
  },
  {
    id: "corrections",
    title: "Corrections and the backlog review",
    body: () => (
      <>
        <p>
          A closed day changes only through a correction. Open the task and,
          under Days, press <L>Request correction</L> on that day. Choose the{" "}
          <L>New status</L>, give a <L>Reason</L> and press{" "}
          <L>Save correction</L>. Done or Cancelled also closes every later day
          of the task. Yet to Start, In Progress or Blocked on the day a
          finished task ended reopens it. Every correction is kept with your
          reason.
        </p>
        <p>
          Rows planned before a tracker&apos;s go-live are history only. When
          some are still open, the <L>Backlog review</L> opens after activation,
          and later from the tracker&apos;s page (open rows before go-live).
          Tick rows, choose <L>Bring to today</L>, <L>Mark done</L> or{" "}
          <L>Cancel</L> (with a reason), then <L>Apply to selected</L>. Bring to
          today puts a task on today, or on the go-live day while that is ahead.
          Rows left alone stay history only.
        </p>
      </>
    ),
  },
  {
    id: "template-columns",
    title: "The template's columns",
    body: () => (
      <>
        <p>
          The {KNIT_STANDARD_V2.name} has one header row with{" "}
          {KNIT_STANDARD_V2.headers.length} columns, A onwards:{" "}
          {KNIT_STANDARD_V2.headers.join(", ")}.
        </p>
        <List>
          <li>
            Never rename, delete or double a header. Knit finds columns by these
            names and reads all of them, so changing one pauses the tracker
            until it is put back and resumed.
          </li>
          <li>
            Keep them in this order with no column between them: that is how{" "}
            <L>{STANDARD_BUTTON}</L> recognises the template at setup. Moving a
            column of a connected tracker does not pause it.
          </li>
          <li>
            Brand columns go after Notes. Knit adds Knit Note and the hidden
            Knit ID after them.
          </li>
          <li>
            Date and End date are real date cells. End date is only for a task
            of several days; leave it blank for a one-day task.
          </li>
          <li>
            Status uses its five words: {SHEET_STATUS_WORDS}. Priority High
            marks a task critical.
          </li>
          <li>
            Spell each name the same way in Owner and Maker. A task that is not
            needed is set to Cancelled with the reason in Notes, never deleted.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "template-link",
    title: "Tracker template link",
    body: ({ template }) => (
      <>
        <p>
          Save the link to the blank tracker template here. Everyone then sees{" "}
          <L>{TEMPLATE_LINK_COPY.get}</L> under Add a new tracker, which opens
          Google&apos;s page to make their own copy.
        </p>
        <List>
          <li>
            Share the blank template so everyone can view it (Share &gt; General
            access, for example anyone at Noboru with the link, as Viewer).
            Google shows the copy page only to people who can view the file.
          </li>
          <li>
            Keep the template outside the Knit folder, or press <L>Ignore</L>{" "}
            when it is listed under <L>New sheet found</L>. Never connect it:
            Knit would add its Knit ID and Knit Note columns, and every copy
            would carry them.
          </li>
        </List>
        <ActionForm
          action={saveTemplateLink}
          submitLabel={TEMPLATE_LINK_COPY.submit}
        >
          <Field
            label={TEMPLATE_LINK_COPY.label}
            htmlFor="template-url"
            hint={TEMPLATE_LINK_COPY.hint}
          >
            <TextInput
              id="template-url"
              name="url"
              inputMode="url"
              autoComplete="off"
              defaultValue={template?.url ?? ""}
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
          </Field>
        </ActionForm>
      </>
    ),
  },
];

function Contents({ sections }: { sections: readonly GuideSection[] }) {
  return (
    <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {sections.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            className="underline-offset-2 hover:underline"
          >
            {section.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

function SectionBlock({
  section,
  props,
  level = 2,
}: {
  section: GuideSection;
  props: GuideProps;
  /** The admin sections sit under "For the admin". */
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section
      id={section.id}
      aria-labelledby={`${section.id}-title`}
      className="scroll-mt-20 rounded-xl border bg-card p-4 sm:p-5"
    >
      <Heading
        id={`${section.id}-title`}
        className="mb-2 text-base font-semibold text-foreground"
      >
        {section.title}
      </Heading>
      <div className="flex flex-col gap-3 text-sm leading-6 text-muted-foreground">
        {section.body(props)}
      </div>
    </section>
  );
}

export function Guide(props: GuideProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Guide</h1>
        <p className="text-sm text-muted-foreground">
          How to use Knit, in short sections.
        </p>
      </div>
      <nav aria-label="Contents" className="rounded-xl border p-4 sm:p-5">
        <Contents sections={EVERYONE} />
        {props.isAdmin ? (
          <>
            <p className="mt-3 mb-1 text-sm font-semibold">For the admin</p>
            <Contents sections={ADMIN} />
          </>
        ) : null}
      </nav>
      {EVERYONE.map((section) => (
        <SectionBlock key={section.id} section={section} props={props} />
      ))}
      {props.isAdmin ? (
        <>
          <h2
            id="for-the-admin"
            className="mt-3 text-lg font-semibold tracking-tight"
          >
            For the admin
          </h2>
          <p className="-mt-3 text-sm text-muted-foreground">
            Only the admin sees this part.
          </p>
          {ADMIN.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              props={props}
              level={3}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
