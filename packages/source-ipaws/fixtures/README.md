# The fixtures of the IPAWS source

- `feed-empty.xml` is a real answer of the public feed of IPAWS when the feed has no new alert. The answer came on 2026-11-15.
- The tests put alerts into this envelope. The feed gives each alert in this envelope, as a child of `ns1:alerts`.
- The alerts of the tests are the real IPAWS copies of one flash flood warning of a Texas office. Their home is `../../format-cap/fixtures/pairs/`.
- The fixtures hold no message of a local authority. Such a message can contain personal data. The tests make each message of an authority from a template, with the status `Test` and a test domain.
