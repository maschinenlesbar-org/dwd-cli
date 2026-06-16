# Data license

> **This tool does not include, host, or redistribute any data.**
> `dwd-cli` is a *client*. It only accesses data served live by the **Deutscher
> Wetterdienst (DWD)**. That data is the DWD's and is governed by **their** terms,
> summarized below. The license of this CLI's own source code is a separate matter
> — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Deutscher Wetterdienst (DWD) |
| **API / source** | Warnwetter app feeds (`app-prod-ws.warnwetter.de`, `app-prod-static.warnwetter.de`) · docs: https://dwd.api.bund.dev/ |
| **Data license** | **GeoNutzV** (Geodaten-Nutzungsverordnung des Bundes); the DWD CDC/OpenData area maps this onto **CC BY 4.0**. Both are CC-BY-like: free reuse with mandatory source attribution. |
| **License text** | https://www.dwd.de/copyright · GeoNutzV: https://www.gesetze-im-internet.de/geonutzv/ · CDC: https://opendata.dwd.de/climate_environment/CDC/Terms_of_use.pdf |
| **Attribution** | **Required** (see templates below). |
| **Commercial use** | Allowed (GeoNutzV / CC BY 4.0 permit commercial reuse with attribution). |
| **Redistribution / modification** | Both permitted; the source reference must accompany the data, and modified data must be labeled. |

## Attribution

DWD specifies exact Quellenvermerk templates
(https://www.dwd.de/DE/service/rechtliche_hinweise/vorlagen_quellenangabe.html):

```
Unmodified:  Quelle: Deutscher Wetterdienst
Modified:    Datenbasis: Deutscher Wetterdienst, eigene Bearbeitung
```

(For graphics, the DWD logo alone suffices as a source mark.)

## Notes & caveats

> [!IMPORTANT]
> **This CLI serves official weather *warnings*.** DWD's terms have a special
> rule: if you **modify** official weather warnings, the DWD source attribution
> **must be removed** ("ist der beigegebene Quellvermerk zu löschen"), and the
> source reference must be deleted whenever use does not match the intended
> purpose (timely, complete delivery to all users). Do **not** present altered
> warning content under a DWD source label.

- Distinguish unmodified (`Quelle:`) from modified (`Datenbasis: …, <edit>`)
  attribution; the note must accurately describe the modification.
- CC BY 4.0 is stated verbatim for the **CDC/OpenData** (climate) area; the
  Warnwetter app feeds fall under DWD's general GeoNutzV terms (functionally
  equivalent: free reuse + Quellenangabe).

## Sources

- https://www.dwd.de/DE/service/rechtliche_hinweise/vorlagen_quellenangabe.html — Quellenvermerk templates + warnings rule
- https://opendata.dwd.de/climate_environment/CDC/Terms_of_use.pdf — CC BY 4.0 (CDC)

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
