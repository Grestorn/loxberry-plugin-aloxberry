# Audio-Player & Musikfavoriten — Stolperfallen und der Favoriten-Workaround

[← Zurück zur Übersicht](README.md) · 🇬🇧 [English](../en/audio.md)

Audio ist die eine Gerätekategorie, bei der Alexa aktiv gegen dich
arbeitet. Diese Seite erklärt **warum**, wie du **Dinge so benennst, dass
Sprachsteuerung tatsächlich funktioniert**, und einen **erprobten
Workaround**, um Zonenfavoriten des Loxone Audioservers (`AudioZoneV2`) per
Sprache zu starten — was die Loxone-API sonst nicht erlaubt.

> Siehe auch: [devices.md → Audio-Zeilen & Hinweis zur Einschränkung](devices.md)
> für die Fähigkeiten-Tabelle und die zugrunde liegende API-Einschränkung.

---

## 1. Warum Alexa-Audio schwierig ist (zuerst lesen)

Alexa behandelt Musik als **eigene Funktion**. Wenn eine Äußerung *nach*
Musik klingt, leitet Amazons Sprachverständnis sie an Amazon Music / den
Standardanbieter weiter, **bevor** sie diesen Skill überhaupt erreicht — das
passiert in Amazons Cloud, das Plugin kann daran nichts ändern.

Konkret:

- **„Alexa, spiele …"**, **„Alexa, Pause"**, **„Alexa, nächster Titel"** und
  ähnliche Transport-Phrasen werden sehr oft von Alexas eigener Musikebene
  abgefangen statt an deine Loxone-Zone gesendet. Das ist
  Plattform-Verhalten, **kein Fehler des Plugins**.
- **Lautstärke und Stumm** sind verlässlich (generische Gerätebefehle, keine
  Musik-Intents): *„Alexa, stelle Martins Sound auf 30 %"*, *„Alexa,
  schalte Martins Sound stumm"*.
- **Favoriten-/Quellennamen sind extrem wichtig.** Heißt ein Favorit
  *„Jazz"*, *„Radio"*, *„Pop"*, *„Chill"*, *„Bayern 1"* oder ähnlich wie
  Inhalte, die Alexa selbst abspielen kann, löst das Aussprechen
  höchstwahrscheinlich **Amazon Music** aus statt deiner Loxone-Zone.

### Namens-Disziplin (das Wichtigste auf dieser Seite)

Wähle Geräte- **und** Favoriten-/Szenennamen, die Alexa **nicht** mit dem
eigenen Musikkatalog verwechseln kann:

| Vermeiden (Alexa kapert) | Besser (sprachsicher) |
|---|---|
| „Jazz", „Rock", „Pop", „Chill" | „Mix Eins", „Morgenliste", „Bürofavorit" |
| „Radio", „Radio Bayern", „80er" | „Zone Bad", „Sender A", „Liste Drei" |
| Echte Sender-/Künstlernamen | Ein kurzes Kunstwort, das *nur* deins ist |

Faustregeln:

- Mache den Namen zu einem **Kunstwort**, nicht zu einem Genre, Künstler,
  Sender oder einer Aktivität.
- Halte ihn **kurz und eindeutig** (max. zwei Wörter, gut aussprechbar).
- Halte ihn **raumübergreifend eindeutig** — der Name *ist* der
  Sprachbefehl.
- Bevorzuge **„Alexa, aktiviere \<Name\>"** (Szenen-Stil) gegenüber
  „spiele": Das Verb *aktiviere* wird von der Musik-Erkennung deutlich
  seltener verschluckt als *spiele*.

---

## 2. Was der Audio Player (AudioZoneV2) nicht kann — und warum

Die klassische **Music Server Zone** (`AudioZone`, der abgekündigte Loxone
MusicServer) unterstützt den vollen Audio-Umfang: Quellen-/Favoritenwahl,
Wiederholung und Zufall. Das Plugin gibt diese als Alexa
**ModeController** (Quelle + Wiederholung) und **ToggleController**
(Zufall) frei.

Der neuere **Audio Player** (`AudioZoneV2`, der Loxone **Audioserver**) hat
einen viel kleineren Befehlssatz. Laut offizieller Loxone-Strukturdatei
(v17) versteht eine `AudioZoneV2`-Zone nur: `volUp`, `volDown`, `volume`,
`tts`, `playZoneFav`, `prev`, `next`, `play`, `Pause`, `bluetooth`,
`presence`. Es gibt **keinen `source`-/`repeat`-Befehl und keinen
`shuffle`-Befehl** — das waren V1-MusicServer-Funktionen, die der
Audioserver-Baustein nicht besitzt.

Deshalb bietet das Plugin für `AudioZoneV2` **weder ModeController noch
ToggleController** an — sie sind aus der Geräteauswahl entfernt und werden
Alexa nie gemeldet. Das ist Absicht, kein Fehler: Eine Wiederholungs- oder
Zufalls-Steuerung anzuzeigen, die die Hardware stillschweigend ignoriert,
wäre schlechter als sie wegzulassen. Für `AudioZoneV2` bleiben Power,
Lautsprecher (Lautstärke/Stumm), Wiedergabe (Play/Pause/Weiter/Zurück) und
Wiedergabestatus.

| Fehlende Fähigkeit | Warum sie bei AudioZoneV2 fehlt | Emulierbar? |
|---|---|---|
| **Quelle / Favoriten** (ModeController) | Favoriten werden dem Miniserver nicht bereitgestellt, und die eigene Favoriten-API des Audioservers weist Drittclients ab (`command not allowed when paired`). Vollständige Untersuchung: [devices.md](devices.md) + Projektplan. | **Ja** — über den Radio→`Fav`-Workaround, siehe [tips.md §2](tips.md#2-audioserver-favoriten-per-sprache-starten-radiofav-workaround). |
| **Wiederholung** (ModeController) | Der Audio-Player-Baustein hat **gar keinen Wiederholungs-Befehl** — der Funktionsbaustein selbst unterstützt das nicht. | **Nein.** Es gibt nichts zu verdrahten; der Audioserver kann per API nicht wiederholen. |
| **Zufall** (ToggleController) | Der Audio-Player-Baustein hat **gar keinen Zufalls-Befehl** — wie bei der Wiederholung. | **Nein.** Gleicher Grund — es gibt keinen Eingang/Befehl dafür. |

Also: **Quelle lässt sich umgehen** (siehe §3 und
[tips.md §2](tips.md#2-audioserver-favoriten-per-sprache-starten-radiofav-workaround)),
aber **Wiederholung und Zufall lassen sich nicht emulieren**, weil der
zugrunde liegende Audio-Player-Baustein keinen Mechanismus dafür bietet —
weder am Miniserver noch am Audioserver. Wenn du Wiederholung/Zufall an
einer Audioserver-Zone brauchst, stelle es einmalig in der Loxone-App ein;
per Sprache ist es über dieses Plugin nicht steuerbar.

---

## 3. Audioserver-Favoriten per Sprache starten

Für `AudioZoneV2`-Zonen lässt sich die Favoritenwahl per Sprache über einen
Loxone **Radio**-Baustein am `Fav`-Eingang nachbauen — der Radio-Baustein
wird vom Plugin als Szene an Alexa freigegeben, jede Radiotaste startet
einen Zonenfavoriten.

Die vollständige Schritt-für-Schritt-Anleitung (Verdrahtung,
Radio-Nummer ⇔ Favoriten-ID, Freigabe als `SCENE_TRIGGER`) steht in
**[tips.md → Audioserver-Favoriten per Sprache starten](tips.md#2-audioserver-favoriten-per-sprache-starten-radiofav-workaround)**.
Die **Namens-Disziplin aus §1 dieser Seite** gilt dort 1:1: Radio-Ausgänge,
die wie Amazon-Inhalte klingen, werden trotz korrekter Verdrahtung von
Amazon Music gekapert.

---

## 4. Kurz-Checkliste

- [ ] Audio-Transport („Play/Pause/Weiter") ist durch Alexa-Design
      unzuverlässig — nutze stattdessen Lautstärke/Stumm und das
      **Aktivieren** von Favoriten.
- [ ] Jeder Gerätename und jede Favoriten-/Radio-Bezeichnung ist ein
      **erfundener, sprachsicherer Name** (kein Genre/Künstler/Sender/
      Aktivitätswort).
- [ ] Für AudioZoneV2-Favoriten: Schritte aus
      [tips.md §2](tips.md#2-audioserver-favoriten-per-sprache-starten-radiofav-workaround)
      umgesetzt.
