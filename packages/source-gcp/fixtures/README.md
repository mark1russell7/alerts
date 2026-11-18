# The fixtures of the source of Google Cloud Service Health

- `incidents-20261118.json` comes from the real answer to `https://status.cloud.google.com/incidents.json`. The answer had the date `Last-Modified: Wed, 18 Nov 2026 05:24:17 GMT`.
- The real answer had 8 incidents. The fixture keeps 2 of them with no change: `utF3FMFdQfwBzJcGG6vf` and `41E5S3mkTGDfkZuJZH5k`.
- The first incident is an outage of the severity `high`. The second incident is a notice of the severity `low`, with 8 locations.
- Each incident of the answer had ended. The tests remove the field `end` to make a live incident.
- The answer had `Content-Type: application/json`, a `Last-Modified` date and no `ETag`. A request with `If-Modified-Since` and that date got a 304 with no body.
- Google owns the texts of the incidents. The texts are notices of the operation of a service.
- The answer contains no personal data. The fixture has an indent of 2 spaces.
