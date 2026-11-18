# The fixtures of the status-page source

- `cloudflare-20261118.json` comes from the real answer to `https://www.cloudflarestatus.com/api/v2/summary.json`. The site sent it at 2026-11-18 04:34:02 UTC.
- The real answer had all the components of the page. The fixture keeps the 5 components that the incidents name, with no change. The other fields are the real fields.
- The fixture keeps the 2 incidents and their updates with no change. One incident is in the state `monitoring`, and the other is in the state `identified`.
- The fixture keeps 2 of the scheduled maintenances. The source makes no report of a maintenance.
- The answer had `Content-Type: application/json` and an `ETag`. Atlassian Statuspage hosts the page.
- `openai-20261118.json` comes from the real answer to `https://status.openai.com/api/v2/summary.json`. The site sent it at 2026-11-18 04:53:17 UTC.
- The fixture keeps 4 components and the one incident, with no change. The incident has no `shortlink`, no `started_at` and no components.
- The answer had `Content-Type: application/json` and no `ETag`. incident.io hosts the page.
- Cloudflare and OpenAI own the texts of their incidents. The texts are short notices of the operation of a service.
- The answers contain no personal data. The fixtures have an indent of 2 spaces.
