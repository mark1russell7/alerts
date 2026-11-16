# The CAP messages of the WMO hub of CAP feeds

The two messages are real. Each one came from the CAP feed of a national weather service on the hub `cap-sources.s3.amazonaws.com`. The WMO Register of Alerting Authorities names these feeds. The feed of each service gives its copyright as `public domain`.

- `oet-wind.xml` is a strong wind warning of the Niue Meteorological Service, sent on 2026-10-22. Its event code is `OET:v1.2 OET-218`, and its area is a circle.
- `oet-thunderstorm.xml` is a thunderstorm warning of the Civil Aviation Authority of Qatar, sent on 2026-11-11. Its event code is `OET:v1.2 OET-194`, and its area is a polygon.

The files keep each byte of the messages, but not the XML signature of the hub. The certificate of the signature names a person.

The folder `nu-gov-en` has the four other messages of the index `../index/nu-gov-en.rss.xml`. Each one is a message of the Niue Meteorological Service, sent from 2026-10-08 to 2026-10-16. Two are strong wind warnings (`OET-218`). Two are drought alerts (`OET-063`). The two messages of 2026-10-15 and 2026-10-16 are updates with a reference.

The name of each file is its name on the hub. The files keep each byte of the messages, but not the XML signature of the hub.
