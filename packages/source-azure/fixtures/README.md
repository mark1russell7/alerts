# The fixtures of the source of Azure Status

- Each fixture is a real answer of the RSS feed of Azure Status at `https://azure.status.microsoft/en-us/status/feed/`. The Wayback Machine of the Internet Archive kept each answer. The fixtures keep the text of each answer with no change. The saved answers had CRLF line ends, and the repository keeps LF line ends (`.gitattributes`).
- The name of each fixture is the UTC time of its capture. The source reads the same feed from the host `rssfeed.azure.status.microsoft`, as the status page links it.
- `feed-20240719T153048Z.xml` has 1 item: the awareness of a failure of virtual machines, with 40 regions.
- `feed-20240721T181144Z.xml` has 1 item with no category.
- `feed-20240730T171154Z.xml` has 1 item: a failure of the network infrastructure, with 40 regions and the category `Public Non-Regional`.
- `feed-20241220T213324Z.xml` has no item: the feed with no incident.
- `feed-20241227T041223Z.xml` has 1 item: a failure of storage in one region, with 7 services and the category `Public Non-Regional`.
- Microsoft owns the texts of the items. The texts are notices of the operation of a service.
- The answers contain no personal data.
