# HN robots.txt snapshots

The Worker can't fetch `news.ycombinator.com` (see Amendment 1 in
[../METHOD.md](../METHOD.md)), so HN's crawl policy is recorded by hand: saved
from the maintainer's machine at the start and at the end of the study, byte for
byte as received, with:

```sh
curl -sS -A "hn-new-study/0.1 (+https://github.com/levimbraga/hn-new-study)" \
  -o docs/robots/YYYY-MM-DD.txt https://news.ycombinator.com/robots.txt
```

| file | fetched (UTC) | HTTP | bytes | SHA-256 |
|---|---|---|---|---|
| [2026-09-30.txt](2026-09-30.txt) | 2026-09-30 17:14:39 | 200 | 243 | `2391981cd9331481b06bac19761a772a9cff2e168ebc8359dcae7a53af0ec257` |
