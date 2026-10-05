# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `dwd`, eines pro Skill: eine
Anfrage, die `dwd`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief gegen die Live-API; jeder Abschnitt nennt Datum und `dwd`-Version.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [dwd-crowd-check](#dwd-crowd-check) · [dwd-station-forecast](#dwd-station-forecast) · [dwd-warning-briefing](#dwd-warning-briefing) · [dwd-warning-map](#dwd-warning-map)

## dwd-crowd-check

Lief am 6. Oktober 2026 um 00:58 mit `dwd` 0.2.0.

> Melden Leute rund um Hamburg heute Regen oder starken Wind? Warnt der DWD davor?

```bash
dwd --compact crowd                      # 418 Meldungen bundesweit
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
```

Laut Feed ist `windowsSizeHours: 1`, aber `start`/`end` umfassen 12 Stunden (05.10. 12:58 bis
06.10. 00:58), und in der letzten Stunde lag keine einzige Meldung. Der Skill hat deshalb das ganze
Fenster und die letzte Stunde getrennt ausgewiesen. Berücksichtigt wurden Meldungen im Umkreis von
±0,5° um Hamburg (53,55 N, 10,0 O), ohne die 9 `BEWOELKUNG`-Meldungen. Genannt werden nur der Ort
und eine Stundenspanne, nichts, was auf einzelne Meldende schließen lässt.

```
Crowd-Meldungen rund um Hamburg, 05.10. 12:58 – 06.10. 00:58: 10 Meldungen, 1 ohne Bewölkung

  WIND     1×  WIND_STARK (Norderstedt), am frühen Nachmittag (14:00–15:00), kein Foto, keine Likes
  keine Meldungen zu REGEN, GEWITTER, BLITZE, HAGEL, NEBEL oder GLAETTE in der Gegend
  die Bewölkungsmeldungen waren alle wolkenlos bis leicht bewölkt (WOLKENLOS, LEICHT_BEWOELKT)

  Letzte Stunde (23:58–00:58): in ganz Deutschland keine Meldungen

  Abgleich mit dem DWD: keine aktiven Nowcast- oder Gemeindewarnungen in ganz Deutschland. Das
  passt: eine Meldung starken Winds am Nachmittag, kein Regen rund um Hamburg gemeldet.

  Bundesweit im Fenster: 360 Bewölkungs-, 55 Wind- und 3 Regenmeldungen; stärkste Ausprägung je
  Kategorie: BEWOELKUNG_BEDECKT, REGEN_LEICHT und WIND_STUERMISCH.
  Crowd-Meldungen sind ungeprüfte Nutzereingaben; maßgeblich sind die amtlichen Warnungen.
```

## dwd-station-forecast

Lief am 6. Oktober 2026 um 00:57 mit `dwd` 0.2.0.

> Vorhersage für Hamburg und Stuttgart für die nächsten Tage im Vergleich – wird ein Regenschirm gebraucht?

```bash
dwd --compact station-overview --id 10147 --id 10739
```

Für beide Stationen kamen Tageswerte zurück; die stündlichen Arrays `windSpeed`, `windGust`,
`windDirection` und `precipitationProbablity` waren `null`. `temperature` hatte 241 Stundenwerte
ab Mitternacht, die kürzeren Arrays (`precipitationTotal` 72, `sunshine` 74) endeten am Freitag um
00:00, wo das dreistündliche `forecast2` übernimmt. Der Skill hat den Wind aus `days` genommen, den
stündlichen Regen aus `forecast1` (am Ende ausgerichtet) und den Sonnenschein je Tag als Summe der
Reihen: `days[].sunshine` meldete für Stuttgart am Donnerstag `0`, die Reihen haben 22 Minuten.
Diesmal war kein Wert in den Reihen der beiden Stationen `null` (die Fehlwert-Markierung).

```
Hamburg (10147) und Stuttgart (10739)

             Hamburg                                       Stuttgart
  Di 06.10.  12,9–18,2 °C   0,0 mm  11,1 km/h SW  1,4 h Sonne   10,2–22,3 °C   0,0 mm   7,4 km/h O   9,5 h Sonne
  Mi 07.10.  12,1–18,8 °C   0,0 mm  14,8 km/h SO  4,1 h         11,8–23,2 °C   0,0 mm   7,4 km/h SO  6,8 h
  Do 08.10.   9,3–13,1 °C  11,5 mm  24,1 km/h NW  2,2 h          9,3–16,5 °C  13,8 mm  16,7 km/h NW  0,4 h
  Fr 09.10.   8,4–12,6 °C   7,1 mm  25,9 km/h SW  1,4 h          7,8–14,3 °C   0,5 mm  13,0 km/h W   3,6 h
  Böen bis 57,4 km/h (Hamburg, Do) und 46,3 km/h (Stuttgart, Do)
  Sonne heute: Hamburg 07:30–18:44, Stuttgart 07:30–18:52 (MESZ)

Donnerstag, stündlicher Regen:
  Hamburg    von Mitternacht bis Mitternacht, am stärksten 05:00–09:00 (1,0–1,3 mm/h), ab 14:00 leicht
  Stuttgart  von 01:00 bis 21:00, am stärksten 07:00–13:00 (0,8–1,5 mm/h)

Regenschirm: heute und morgen nicht, beide Städte bleiben trocken. Am Donnerstag in beiden ja,
den ganzen Tag. Freitag: Hamburg wieder nass (7,1 mm), Stuttgart weitgehend trocken (0,5 mm).
Stündlicher Wind und Regenwahrscheinlichkeit: vom DWD für diese Stationen nicht geliefert.
```

## dwd-warning-briefing

Lief am 6. Oktober 2026 um 00:58 mit `dwd` 0.2.0.

> Warnt der DWD gerade vor irgendetwas in Deutschland, auch an der Küste?

```bash
dwd --compact warnings nowcast           # {"time":…,"warnings":[],"binnenSee":null}
dwd --compact warnings gemeinde          # {"time":…,"warnings":[],"binnenSee":{}}
dwd --compact warnings coast             # {"time":…,"warnings":{},"vorabInformation":{}}
```

Alle drei Feeds waren um 00:58 MESZ leer. Leere Feeds mit Exit 0 sind eine echte Antwort. Der
Skill hat deshalb ruhiges Wetter gemeldet, statt es erneut zu versuchen oder zu raten.

```
Deutschland: derzeit keine aktiven DWD-Warnungen (Stand 06.10.2026, 00:58 MESZ)

  Nowcast    0 Warnungen            Feed-Zeit 00:55
  Gemeinde   0 Warnungen            Feed-Zeit 00:50, keine Binnensee-Warnungen (binnenSee)
  Küste      0 Küstenzonen          Feed-Zeit 00:50, keine Vorabinformation
```

Als Nächstes angeboten: später erneut prüfen oder mit dem Crowd-Check nachsehen, was vor Ort gemeldet wird.

## dwd-warning-map

Lief am 6. Oktober 2026 um 00:58 mit `dwd` 0.2.0.

> Die aktuellen DWD-Warngebiete aus allen drei Feeds als GeoJSON exportieren, zum Laden in QGIS.

```bash
dwd --compact warnings nowcast > nowcast.json
dwd --compact warnings gemeinde > gemeinde.json
dwd --compact warnings coast > coast.json
```

Der Skill hat die FeatureCollection für die beiden Array-Feeds aus `regions[].polygonGeometry`
gebaut und das nach Zonen geschlüsselte Objekt des Küsten-Feeds durchlaufen. Kein Feed enthielt
eine Warnung, es gab also nichts umzuwandeln; `dwd-warnings.geojson` existierte noch nicht, es
wurde also nichts überschrieben.

```
Derzeit keine aktiven DWD-Warnungen für die Karte.

  Nowcast 0 · Gemeinde 0 · Küste 0 Zonen   (Feed-Zeiten 00:50–00:55 MESZ)
  dwd-warnings.geojson geschrieben: FeatureCollection mit 0 Features (42 Bytes), gültiges JSON.
  Das ist ein leeres Ergebnis, kein fehlgeschlagener Export.
```

Als Nächstes angeboten: bei neuen Warnungen mit demselben Dateinamen erneut ausführen und die
Polygone nach `level` einfärben.
