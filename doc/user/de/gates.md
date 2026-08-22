# Tore & Garagentore

[← Zurück zur Übersicht](README.md) · 🇬🇧 [English](../en/gates.md)

Ein Loxone-**Tor**-Baustein (Funktionsbaustein *Garage/Tor* — API-Typ `Gate`)
lässt sich Alexa auf **zwei verschiedene Arten** übergeben. Im Reiter *Geräte*
sehen beide fast gleich aus, sie verhalten sich aber deutlich unterschiedlich:
bei einer davon **fragt Alexa vor dem Öffnen nach einem gesprochenen
Sicherheitscode**.

Wenn das Tor eine Zufahrt zu deinem Grundstück sichert, ist dieser Unterschied
wichtig. Diese Seite erklärt beide Varianten, damit du bewusst wählen kannst.

---

## Die zwei Arten, ein Tor freizugeben

| | **Tür** *(Standard)* | **Garagentor** *(optional)* |
|---|---|---|
| Alexa-Kategorie | `DOOR` | `GARAGE_DOOR` |
| Fähigkeit | Bereich (Position) | Modus |
| *„Alexa, öffne \<Name\>"* | öffnet sofort | **Alexa fragt zuerst nach dem Sprachcode** |
| *„Alexa, schließe \<Name\>"* | schließt sofort | schließt sofort — ohne Code |
| *„Alexa, stelle \<Name\> auf 50"* | ✅ jede Position | ❌ nicht verfügbar |
| Einstellung **Richtung umkehren** | ✅ | — (nicht anwendbar) |
| In jeder Alexa-Sprache verfügbar | ✅ | ⚠️ **nicht auf Niederländisch** — siehe unten |

Keine der beiden Varianten ist „richtiger". Ein Hoftor, das ohnehin nur ganz
auf oder ganz zu fährt, passt gut zu **Garagentor**. Ein Tor, das du gerne
halb offen für den Hund stehen lässt, ist als **Tür** besser aufgehoben.

---

## Was der Sprachcode ist — und wer ihn prüft

Ist ein Tor als **Garagentor** freigegeben, erkennt Alexa es als solches und
Amazon wendet seine eigene Regel für diese Geräteklasse an:

> *„Alexa, öffne das Garagentor."*
> *„Wie lautet dein Sprachcode?"*
> *„Eins zwei drei vier."*
> — und erst jetzt macht sich der Befehl auf den Weg zu deinem LoxBerry.

Entscheidend ist, **wo der Code liegt**: vollständig in **Amazons Cloud**. Du
hinterlegst ihn je Gerät in der Alexa-App, Amazon prüft ihn, und erst wenn er
stimmt, erreicht überhaupt etwas die Bridge oder deinen LoxBerry.

- Das Plugin **sieht den Code nie**, speichert ihn nicht und kann ihn nicht
  prüfen.
- Die Bridge ebenso wenig — und damit auch niemand, der eine der beiden
  kompromittiert hat: Der Code ist dort schlicht nicht vorhanden.
- Ein falscher Code bedeutet, dass der Befehl gar nicht erst gesendet wird.
  Dein Miniserver erfährt von dem Versuch nichts.

Es ist derselbe Mechanismus, den auch die bekannten kommerziellen
Garagentor-Skills nutzen. Das Plugin implementiert die Abfrage nicht — es meldet
das Gerät nur in genau der Form an, die Alexa erkennt, und genau das löst sie
aus.

**Einen Code zu setzen ist Pflicht.** Amazon verlangt ihn, bevor ein Garagentor
überhaupt per Sprache geöffnet werden kann. Bis du ihn hinterlegst, weigert
sich Alexa zu öffnen und sagt dir das auch.

### Warum das Schließen nicht geschützt ist

Nur das **Öffnen** wird abgefragt. Schließen geht sofort durch, und das mit
Absicht: Das Tor nicht zubekommen, weil man sich bei der PIN verhaspelt, ist
der gefährlichere Fehlerfall. Abgesichert wird hier, dass *jemand dein
Grundstück öffnet* — nicht, dass jemand es schließt.

---

## Ein Tor auf Garagentor-Modus umstellen

1. Öffne im Plugin den Reiter **Geräte** und suche dein Tor (bei langer Liste
   nach Typ `Gate` filtern).
2. Setze die **Kategorie** auf **`GARAGE_DOOR`**. Die Fähigkeit **Modus** setzt
   sich automatisch, **Bereich** fällt weg — beide gehören immer zusammen, du
   änderst also nur eines von beiden.
3. **Änderungen speichern.**
4. Sage **„Alexa, suche neue Geräte"** (oder starte die Suche in der Alexa-App).
5. In der **Alexa-App**: **Geräte → \<dein Garagentor\> → Einstellungen
   (Zahnrad) → Sprachcode**, und einen **vierstelligen Code** festlegen. Die
   genaue Bezeichnung wandert zwischen App-Versionen; halte in den
   Geräteeinstellungen nach *Sprachcode* Ausschau.
6. Ausprobieren: *„Alexa, öffne \<Name\>"*. Sie sollte nach dem Code fragen.

> **Nimm einen Code, den du nirgends sonst verwendest** — nicht deine
> Handy-PIN, nicht den Alarmcode, nicht die PIN deiner Karte. Er wird im Raum
> laut ausgesprochen, und das ist ein ganz anderes Risiko als Eintippen.

Zum Zurückstellen die Kategorie wieder auf `DOOR` setzen und die Gerätesuche
erneut laufen lassen. Zeigt Alexa weiterhin die alte Kachel, lösche das Gerät
in der Alexa-App und suche noch einmal.

---

## Worauf du verzichtest

- **Keine Zwischenpositionen.** Alexas Garagentor kennt nur *offen* und
  *geschlossen* — ein „stelle es auf 30 %" gibt es nicht. Das ist eine Grenze
  von Alexas Garagentor-Modell, nicht deines Loxone-Tors: Die Loxone-App und
  jede Automatik auf Loxone-Seite fahren es weiterhin, wohin du möchtest.
- **Ein halb offenes Tor meldet „offen".** Alles, was nicht vollständig
  geschlossen ist, gilt als offen — genau richtig für eine Routine wie *„wenn
  das Garagentor geschlossen ist, Alarm scharf schalten"*.
- **Auf Niederländisch nicht verfügbar.** Amazon unterstützt Garagentore nur
  auf **Deutsch, Englisch (UK/US), Spanisch (ES/US), Französisch und
  Italienisch**. Niederländisch (`nl-NL`) fehlt, dort erscheint die Kachel
  zwar, ignoriert aber die gesprochenen Verben. Niederländische Haushalte
  bleiben besser bei **Tür** — das funktioniert in jeder Sprache.
- **Richtung umkehren wirkt hier nicht.** Diese Einstellung dreht eine
  Prozent-Achse um; das Garagentor hat keine Prozente. Auf ist auf. (Falls ein
  Tor als *Tür* auf „schließen" geöffnet hat und du das mit dem Häkchen
  korrigiert hattest: Nach dem Umstellen braucht es die Korrektur einfach
  nicht mehr.)

---

## Wenn Alexa nicht nach dem Code fragt

Der Reihe nach durchgehen — die ersten beiden Punkte decken fast alle Fälle ab:

1. **Steht die Kategorie wirklich auf `GARAGE_DOOR`?** Im Reiter *Geräte*
   nachsehen. Ein auf `DOOR` gebliebenes Tor verhält sich wie eine gewöhnliche
   Öffnung und wird nie abgefragt.
2. **Hast du nach dem Speichern die Gerätesuche laufen lassen?** Alexa hält
   eine eigene Kopie des Geräts. Bis du *„Alexa, suche neue Geräte"* sagst,
   arbeitet sie mit der alten Definition. Sieht es danach immer noch falsch
   aus: **Gerät in der Alexa-App löschen** und noch einmal suchen — eine alte
   Kachel ist der übliche Übeltäter.
3. **Ist für dieses Gerät tatsächlich ein Sprachcode hinterlegt?** Eine
   unfertige Einrichtung bedeutet nicht „kein Schutz": Alexa öffnet dann gar
   nicht erst.
4. **In welcher Sprache läuft dein Alexa-Konto?** Auf Niederländisch erreichen
   die Verben den Skill gar nicht (siehe oben).

## Was der Code *nicht* abdeckt

Der Code schützt **gesprochene Befehle an Alexa**. Er ist kein Schloss an
deinem Tor:

- Die **Kachel in der Alexa-App** gehört zu deinem eigenen, angemeldeten
  Amazon-Konto und öffnet das Tor ohne gesprochenen Code.
- Ob eine **Alexa-Routine** das Tor ohne Abfrage öffnen kann, ist Amazons
  Verhalten und nichts, was dieses Plugin steuert. Wenn dir das wichtig ist,
  probiere es einmal mit einer eigenen Routine aus, bevor du dich darauf
  verlässt.
- Alles in **Loxone** — App, Wandtaster, deine eigene Automatik — bleibt
  unberührt. Hier geht es ausschließlich um den Alexa-Weg.

Wenn du den Alexa-Weg unabhängig von Codes hart abschalten willst, nimm die
Mittel des Plugins: das Häkchen **Aktiv** je Gerät, den **Hauptschalter** oder
die Sperre **„Alexa-Befehle pausieren, solange ein Virtueller Status an ist"**.
Siehe [security.md](security.md).

---

## Was soll ich nehmen?

- **Eine Zufahrt zu deinem Grundstück** — Hoftor, Garagentor, Schranke: nimm
  **Garagentor**. Die Abfrage kostet dich zwei Sekunden und ist der ganze
  Grund, warum es diese Option gibt.
- **Ein Tor, das du positionierst** statt nur zu öffnen — oder ein
  **niederländisches** Alexa-Konto: nimm **Tür**.
- **Unsicher?** Fang mit **Garagentor** an. Wenn dich die fehlenden Prozente
  stören, ist das Zurückstellen zwei Klicks und eine Gerätesuche.

---

Siehe auch: **[devices.md](devices.md)** für die vollständige
Loxone-↔-Alexa-Zuordnung · **[security.md](security.md)** dafür, wie dich der
Rest des Plugins schützt.
