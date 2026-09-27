#!/usr/bin/env bash
# PRD 17: time is injected. For the end-to-end tests only: fixes knit_today() to the given
# date for every Data API request of the local Supabase, through a setting on PostgREST's
# login role, and waits until the API answers with it. Only a superuser can set it, and
# production never has it.
#
#   scripts/ci-set-clock.sh 2026-09-28
set -euo pipefail

day="$1"
docker exec -e PGPASSWORD=postgres supabase_db_knit \
  psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c "alter role authenticator set knit.today = '${day}'"
docker restart supabase_rest_knit > /dev/null

eval "$(pnpm exec supabase status -o env | grep -E '^[A-Z_]+=' | sed 's/^/export /')"
today=""
for _ in $(seq 1 30); do
  today=$(curl -s -X POST "${API_URL}/rest/v1/rpc/knit_today" \
    -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" -d '{}' || true)
  [ "${today}" = "\"${day}\"" ] && exit 0
  sleep 2
done
echo "::error title=Clock not set::knit_today() answered ${today}"
exit 1
