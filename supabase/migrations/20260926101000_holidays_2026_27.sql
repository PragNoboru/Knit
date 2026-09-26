-- PRD 6.2: the holiday list from fixtures/holidays.json (India FY 2026-27, provided by
-- Pragaman on 25 Sep 2026), then the first calendar build for 2026-01-01 to 2027-12-31.
-- A migration, not seed.sql, so every environment, production included, has them.
-- tests/unit/holidays-migration.test.ts checks this list against the fixture.

insert into public.holidays (day, name) values
  ('2026-04-14', 'Ambedkar Jayanti'),
  ('2026-05-01', 'Labour Day'),
  ('2026-08-15', 'Independence Day'),
  ('2026-09-14', 'Ganesh Chaturthi'),
  ('2026-10-02', 'Gandhi Jayanti'),
  ('2026-10-20', 'Dussehra'),
  ('2026-11-08', 'Diwali'),
  ('2027-01-01', 'New Year (Hangover Day)'),
  ('2027-01-26', 'Republic Day'),
  ('2027-03-22', 'Holi')
on conflict (day) do nothing;

select public.refresh_calendar('2026-01-01', '2027-12-31');
