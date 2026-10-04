-- PRD N86, 12.8: tracker_requests.unknown_names is how many names in the sheet Knit does not
-- know, each name (normalised) counted once, as the admin's item says ("{k} names in it are not
-- known to Knit yet."). It is not the number of rows that name them: the person sees those rows
-- on the Guide instead (N85). The note in 20261004110000_tracker_requests.sql said rows; this
-- comment on the column is the one that holds.

comment on column public.tracker_requests.unknown_names is
  'N86: names (normalised, each counted once) in the sheet that Knit does not know when the request was sent. Not a count of rows.';
