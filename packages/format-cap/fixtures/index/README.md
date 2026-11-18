# The indexes of CAP feeds

The three files are real indexes of CAP feeds. The WMO Register of Alerting Authorities names each feed. Each entry of an index links to one CAP message.

- `nu-gov-en.rss.xml` is the RSS 2.0 index of the feed of the Niue Meteorological Service on the hub `cap-sources.s3.amazonaws.com`, read on 2026-11-16. It has 5 items. The feed gives its copyright as `public domain`. The messages of the items are in `../hub`: `oet-wind.xml` and the four files of `../hub/nu-gov-en`.
- `dwd-en.atom.xml` is the Atom 1.0 index of the English CAP feed of the Deutscher Wetterdienst (DWD), read on 2026-11-16. It has 36 entries. The feed gives its rights as `public domain`.
- `geonet-quake.atom.xml` is the Atom 1.0 index of the earthquake CAP feed of GeoNet, read on 2026-11-16. It has no entry. Credit: "Copyright Earth Sciences New Zealand and is licensed under a Creative Commons Attribution 3.0 New Zealand License".

The DWD and GeoNet files keep each byte of the answers, but the repository keeps the lines of each file with LF line ends. The DWD answer has CRLF line ends. A test reads the two forms. The Niue file keeps each byte, but not the `author` element of its items. The value of an `author` element can be the mail address of a person.
