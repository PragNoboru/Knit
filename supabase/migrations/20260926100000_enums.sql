-- PRD 8.1: enum types used across the schema.

-- PRD 6.1: the six task-day statuses. Users pick the first five; `not_done` is set only by
-- close_day, on locked task-days.
create type public.knit_status as enum (
  'yet_to_start', 'in_progress', 'blocked', 'done', 'cancelled', 'not_done'
);

-- PRD 6.3.1: date kinds stored on tasks. `invalid` and `empty` never reach the database; the
-- pull raises Needs Attention items for them instead.
create type public.date_kind as enum ('single', 'window', 'open');

-- PRD 8.1, 10.1, 14: tracker lifecycle and Drive file states.
create type public.tracker_state as enum ('draft', 'active', 'paused', 'disconnected', 'archived');
create type public.drive_file_state as enum ('new', 'ignored', 'connected', 'not_a_sheet', 'left_folder');

-- PRD 10.4: outbox row states for write-backs to the sheets.
create type public.outbox_state as enum ('pending', 'held', 'done', 'failed', 'superseded');

-- PRD 8.1, 6.10: where a recorded change came from.
create type public.change_origin as enum ('hub', 'source', 'system', 'correction');
