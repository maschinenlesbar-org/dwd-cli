# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `dwd`, eines pro Skill: eine
Anfrage, die `dwd`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `dwd` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [dwd-crowd-check](#dwd-crowd-check) · [dwd-station-forecast](#dwd-station-forecast) · [dwd-warning-briefing](#dwd-warning-briefing) · [dwd-warning-map](#dwd-warning-map)

## dwd-crowd-check

> Melden Leute rund um Hamburg heute Regen oder starken Wind? Warnt der DWD davor?

```bash
dwd --compact crowd                      # 998 Meldungen bundesweit
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
```

Laut Feed ist `windowsSizeHours: 1`, aber `start`/`end` umfassen 12 Stunden (05:41–17:41), und
die Meldungen verteilen sich über die ganze Zeit. Der Skill hat deshalb das ganze Fenster und die
letzte Stunde getrennt ausgewiesen. Berücksichtigt wurden Meldungen im Umkreis von ±0,5° um Hamburg
(53,55 N, 10,0 O), ohne die 24 `BEWOELKUNG`-Meldungen. Genannt werden nur Orte, nichts, was auf
einzelne Meldende schließen lässt.

```
Crowd-Meldungen rund um Hamburg, 15.09. 05:41–17:41: 44 Meldungen, 20 ohne Bewölkung

  REGEN   11×  9 REGEN_LEICHT, 1 REGEN_MITTEL, 1 REGEN_KRAEFTIG
               alle zwischen 07:16 und 09:36, seitdem keine; 2 mit Foto, meiste Likes: 5
               Hamburg (inkl. Hamburg-Nord, Hamburg-Bergedorf), Norderstedt, Reinbek,
               Buxtehude, Braak, Amelinghausen
  WIND     9×  8 WIND_SCHWACH, 1 WIND_STARK (Bad Oldesloe), keine Fotos
  keine Meldungen zu GEWITTER, BLITZE, HAGEL, NEBEL oder GLAETTE in der Gegend

  Letzte Stunde (16:41–17:41): 3 Meldungen, nur Bewölkung (Hamburg, Lüneburg) und schwacher Wind (Lüneburg)
  Gegend der stärksten Regenmeldung (auf ca. 10 km gerundet): https://maps.google.com/?q=53.6,10.2

  Abgleich mit dem DWD: keine aktiven Nowcast- oder Gemeindewarnungen in ganz Deutschland. Das
  passt zu den Meldungen: ein nasser Vormittag mit meist leichtem Regen, nichts Schweres gemeldet.

  Bundesweit stärkste Ausprägung je Kategorie: REGEN_KRAEFTIG, WIND_STARK, NEBEL_EXTREM.
  Crowd-Meldungen sind ungeprüfte Nutzereingaben; maßgeblich sind die amtlichen Warnungen.
```

## dwd-station-forecast

> Vorhersage für Hamburg und Stuttgart für die nächsten Tage im Vergleich – wird ein Regenschirm gebraucht?

```bash
dwd --compact station-overview --id 10147 --id 10739
```

Für beide Stationen kamen Tageswerte zurück. Die stündlichen Arrays `windSpeed`, `windGust`,
`windDirection` und `precipitationProbablity` waren aber `null`, und `temperature` (241 Werte) und
`precipitationTotal` (72) waren unterschiedlich lang. Der Skill hat den stündlichen Regen aus
`forecast1` und den Wind aus `days` genommen.

```
Hamburg (10147) und Stuttgart (10739)

             Hamburg                                  Stuttgart
  Di 15.09.  13,5–25,4 °C  1,3 mm  18,5 km/h S       14,3–28,4 °C  0,0 mm   7,4 km/h SO
  Mi 16.09.  12,2–18,2 °C  5,7 mm  16,7 km/h W       14,1–19,9 °C  0,7 mm  18,5 km/h NW
  Do 17.09.  11,4–17,6 °C  2,0 mm  25,9 km/h SW      11,4–20,9 °C  0,0 mm   9,3 km/h W
  Fr 18.09.  12,7–17,1 °C  2,5 mm  22,2 km/h SW      12,7–18,8 °C  0,0 mm   9,3 km/h W
  Böen bis 50,0 km/h (Hamburg, Do) und 48,2 km/h (Stuttgart, Mi)
  Sonne heute: Hamburg 06:53–19:36, Stuttgart 06:59–19:36 (MESZ)

Hamburg, heute Nacht (stündlich, mm):
  20:00 0,1 · 21:00 0,4 · 22:00 0,5 · 23:00 0,7 · 00:00 0,9 · 01:00 1,0
  02:00 0,8 · 03:00 0,7 · 04:00 0,7 · 05:00 0,6 · 06:00 0,4 · danach abklingend bis 11:00

Regenschirm: in Hamburg ja, von heute Abend bis Mittwochvormittag und wieder Do/Fr.
Stuttgart bleibt trocken, bis auf 0,7 mm am Mittwoch um die Mittagszeit (11:00–14:00).
Stündlicher Wind und Regenwahrscheinlichkeit: vom DWD für diese Stationen nicht geliefert.
```

## dwd-warning-briefing

> Warnt der DWD gerade vor irgendetwas in Deutschland, auch an der Küste?

```bash
dwd --compact warnings nowcast           # {"warnings":[]}
dwd --compact warnings gemeinde          # {"warnings":[],"binnenSee":{}}
dwd --compact warnings coast             # {"warnings":{},"vorabInformation":{}}
```

Alle drei Feeds waren um 17:42 und erneut um 17:49 MESZ leer. Leere Feeds mit Exit 0 sind eine
echte Antwort. Der Skill hat deshalb ruhiges Wetter gemeldet, statt es erneut zu versuchen oder zu
raten.

```
Deutschland: derzeit keine aktiven DWD-Warnungen (Stand 15.09.2026, 17:49 MESZ)

  Nowcast    0 Warnungen            Feed-Zeit 17:45
  Gemeinde   0 Warnungen            Feed-Zeit 17:48, keine Binnensee-Warnungen (binnenSee)
  Küste      0 Küstenzonen          Feed-Zeit 17:48, keine Vorabinformation
```

Als Nächstes angeboten: später erneut prüfen oder mit dem Crowd-Check nachsehen, was vor Ort gemeldet wird.

## dwd-warning-map

> Die aktuellen DWD-Warngebiete aus allen drei Feeds als GeoJSON exportieren, zum Laden in QGIS.

```bash
dwd --compact warnings nowcast > nowcast-2.json
dwd --compact warnings gemeinde > gemeinde-2.json
dwd --compact warnings coast > coast-2.json
```

Der Skill hat die FeatureCollection für die beiden Array-Feeds aus `regions[].polygonGeometry`
gebaut und das nach Zonen geschlüsselte Objekt des Küsten-Feeds durchlaufen. Kein Feed enthielt
eine Warnung, es gab also nichts umzuwandeln.

```
Derzeit keine aktiven DWD-Warnungen für die Karte.

  Nowcast 0 · Gemeinde 0 · Küste 0 Zonen   (Feed-Zeiten 17:45–17:48 MESZ)
  dwd-warnings.geojson geschrieben: FeatureCollection mit 0 Features (42 Bytes), gültiges JSON.
  Das ist ein leeres Ergebnis, kein fehlgeschlagener Export.
```

Als Nächstes angeboten: bei neuen Warnungen mit demselben Dateinamen erneut ausführen und die
Polygone nach `level` einfärben.
