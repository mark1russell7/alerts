# The fixtures of the source of Google Cloud Service Health

- `incidents-20261118.json` comes from the real answer to `https://status.cloud.google.com/incidents.json`. The answer had the date `Last-Modified: Wed, 18 Nov 2026 05:24:17 GMT`.
- The real answer had 8 incidents. The fixture keeps 2 of them with no change: `5fGQt4VbkDnr3Yp8PXPr` and `T8gmtofFSTGT5tbhyciF`.
- Each incident is a disruption of the severity `medium`. The first has 3 products and 9 updates. The second has more than one region and 11 updates.
- The tests change the severity or the status of an incident to test the other values.
- Each incident of the answer had ended. The tests remove the field `end` to make a live incident.
- The answer had `Content-Type: application/json`, a `Last-Modified` date and no `ETag`. A request with `If-Modified-Since` and that date got a 304 with no body.
- Google owns the texts of the incidents. The texts are notices of the operation of a service.
- The answer contains no personal data. The fixture has an indent of 2 spaces.
