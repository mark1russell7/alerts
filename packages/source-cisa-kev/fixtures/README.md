# The fixtures of the CISA KEV source

- `kev-20261117.json` comes from the real answer to `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`. The site sent it at 2026-11-18 04:02:53 UTC.
- The real answer had 1782 entries and 1.9 MB. The fixture keeps 10 entries with no change, and its `count` is 10. The other fields are the real fields.
- Seven entries have a due date that had not ended at 2026-11-18 04:02:53 UTC. The other three entries show the severities: a flaw of ransomware, a flaw with a forensic triage, and an entry of 2021.
- The catalog version is `2026.11.17`, and the release time is 2026-11-17 17:53:15 UTC.
- The answer had `Content-Type: application/json`, an `ETag` and a `Last-Modified` date. The fixture keeps the indent of 4 spaces of the answer.
- The catalog is under the license CC0 1.0 (`https://www.cisa.gov/sites/default/files/licenses/kev/license.txt`). The terms forbid the use of the logo of CISA and the seal of DHS.
- The entries tell of flaws in products. They contain no personal data.
