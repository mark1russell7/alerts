# The fixtures of the NWWS-OI source

- `products-20261116T2002Z.json` holds six real products of the room of NWWS-OI. A capture of 10 minutes got them on 2026-11-16, from 20:02 to 20:12 UTC.
- Each entry has the attributes of the element `x` of the namespace `nwws-oi`, the text of the element, the receipt time and the history flag.
- The fixture holds no stanza. A stanza has the address of the account in the attribute `to`, and the address holds personal data.
- `nwws_processor.3192` is a weather roundup (`RWRIL`) from the history of the room. The stream pads its AWIPS id with a space.
- `nwws_processor.3219` is the communications test of the NCF, with no AWIPS id. The NCF sends this test each minute.
- `nwws_processor.3243` is the keepalive of the NWS: a CAP message with the status `Test` and the AWIPS id `KEPWBC`.
- `nwws_processor.3268`, `nwws_processor.3282` and `nwws_processor.3401` are CAP messages: a Special Marine Warning, a High Wind Watch and a Freeze Warning.
- The text of each product has the WMO heading and the AWIPS id before the body. Each line break of a text product is doubled.
- The text of a CAP product ends after `</alert>` with three line breaks.
- The capture had 251 products with no gap in their sequence numbers. The longest time between two live products was 27 seconds.
- The products of the NWS are works of the US government, in the public domain. They contain no personal data.
