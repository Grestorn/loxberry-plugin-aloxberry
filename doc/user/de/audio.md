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
| **Quelle / Favoriten** (ModeController) | Favoriten werden dem Miniserver nicht bereitgestellt, und die eigene Favoriten-API des Audioservers weist Drittclients ab (`command not allowed when paired`). Vollständige Untersuchung: [devices.md](devices.md) + Projektplan. | **Ja** — über den Radio→`Fav`-Workaround in §3 unten. |
| **Wiederholung** (ModeController) | Der Audio-Player-Baustein hat **gar keinen Wiederholungs-Befehl** — der Funktionsbaustein selbst unterstützt das nicht. | **Nein.** Es gibt nichts zu verdrahten; der Audioserver kann per API nicht wiederholen. |
| **Zufall** (ToggleController) | Der Audio-Player-Baustein hat **gar keinen Zufalls-Befehl** — wie bei der Wiederholung. | **Nein.** Gleicher Grund — es gibt keinen Eingang/Befehl dafür. |

Also: **Quelle lässt sich umgehen** (Rest dieser Seite), aber
**Wiederholung und Zufall lassen sich nicht emulieren**, weil der zugrunde
liegende Audio-Player-Baustein keinen Mechanismus dafür bietet — weder am
Miniserver noch am Audioserver. Wenn du Wiederholung/Zufall an einer
Audioserver-Zone brauchst, stelle es einmalig in der Loxone-App ein; per
Sprache ist es über dieses Plugin nicht steuerbar.

Der Rest dieser Seite ist der **praktische Ausweg** für die Quellen-/
Favoritenwahl bei `AudioZoneV2`.

---

## 3. Workaround — Audioserver-Favoriten per Sprache über einen Radio-Baustein

Der Trick: Loxones **Radio**-Baustein (Radiotasten) hat diskrete,
beschriftete Ausgänge. Verbinde seinen Ausgang mit dem **`Fav`**-Eingang des
Audio Players, dann wählt jede Radiotaste einen Zonenfavoriten. Das Plugin
unterstützt den `Radio`-Typ bereits, sodass jede beschriftete Taste per
Sprache ansprechbar wird.

Du sagst dann:

> **„Alexa, aktiviere \<Favoritname aus dem Radio-Baustein\>"**

### 3.1 Radio-Baustein mit dem `Fav`-Eingang des Audio Players verbinden

Füge in **Loxone Config** einen **Radio**-Baustein („Radiotasten") hinzu und
verbinde dessen **`N`**-Ausgang mit dem **`Fav`**-Eingang des Audio Players:

![Loxone Config: Ein Radio-Baustein („Musik Favoriten"), dessen N-Ausgang in den Fav-Eingang des Audio Players verdrahtet ist](../img/audio-radio-fav-wiring.png)

### 3.2 Radio-Ausgänge beschriften

Gib jedem Radio-Ausgang eine **sprachsichere Bezeichnung** (siehe §1 — genau
diese Bezeichnungen sagst du zu Alexa). Bearbeite die Ausgänge („Ausgänge
bearbeiten"):

![Loxone-Config-Dialog „Ausgänge bearbeiten": jeder Radio-Ausgang 1..n hat eine Textbezeichnung](../img/audio-radio-outputs-config.png)

### 3.3 Radio-Nummer mit der Loxone-Favoriten-**ID** abgleichen

Dieser Schritt entscheidet über Erfolg oder Misserfolg:

- Der **Radio**-Baustein gibt die Werte **1–16** aus (Ausgangsnummer).
- In der **Loxone-App** kannst du jedem Zonenfavoriten **manuell eine ID
  zuweisen** („Favoriten bearbeiten").
- **Die Radio-Ausgangsnummer muss der manuell vergebenen ID des Favoriten
  entsprechen.** Radio-Ausgang 4 → der Favorit mit ID 4 usw. Stimmen sie
  nicht überein, spielt der falsche Favorit (oder keiner).

![Loxone-App „Favoriten bearbeiten": jeder Favorit zeigt eine ID (1, 2, 3 …) und einen Typ (Playlist / Radiosender)](../img/audio-favorites-ids-app.png)

Halte die **Radio-Bezeichnung** (was du sagst) und den **Favoriten bei
dieser ID** (was spielt) synchron. Wenn du Favoriten in der App umsortierst,
prüfe die IDs erneut gegen die Radio-Nummern.

### 3.4 Den Radio-Baustein für Alexa freigeben

Füge im Tab **Geräte** des Plugins den Radio-Baustein hinzu und gib ihn als
**`SCENE_TRIGGER`** frei. Jeder beschriftete Ausgang wird dann zu einer
Alexa-Szene/-Aktivität, die du per Namen auslösen kannst:

> **„Alexa, aktiviere Morgenliste"** → Radio-Ausgang mit Bezeichnung
> „Morgenliste" → `Fav` = diese Nummer → Audioserver spielt den Favoriten
> mit der passenden ID.

> ⚠️ Wende die **Namens-Disziplin aus §1** auf die Radio-Bezeichnungen an.
> Ein Radio-Ausgang, der wörtlich „Bayern 1" oder „Jazz" heißt, wird von
> Amazon Music gekapert, egal wie korrekt er verdrahtet ist. Ein Kunstwort
> wie „Sender Bayern" oder „Liste Eins" sorgt dafür, dass der Sprachbefehl
> in Loxone landet.

### 3.5 Grenzen dieses Workarounds

- Es ist ein **Einweg-Auslöser**: Du startest einen Favoriten, aber Alexa
  hat keine Rückmeldung, welcher Favorit gerade läuft (Szenen-Auslöser sind
  „fire-and-forget").
- Du bist auf die **16 Ausgänge** des Radio-Bausteins begrenzt.
- Es erfordert etwas **Loxone-Config- + Loxone-App**-Einrichtung je Zone; es
  ist eine bewusste Nutzerentscheidung, nichts, was das Plugin für dich tun
  kann (die Favoritennamen liegen nur auf dem Audioserver).
- Nach erneutem Alexa-Verknüpfen oder Hinzufügen von Ausgängen **„Alexa,
  suche nach Geräten"** ausführen, damit die neuen Szenennamen übernommen
  werden.

---

## 4. Kurz-Checkliste

- [ ] Audio-Transport („Play/Pause/Weiter") ist durch Alexa-Design
      unzuverlässig — nutze stattdessen Lautstärke/Stumm und das
      **Aktivieren** von Favoriten.
- [ ] Jedes Gerät, jeder Favorit und jede Radio-Bezeichnung ist ein
      **erfundener, sprachsicherer Name** (kein Genre/Künstler/Sender/
      Aktivitätswort).
- [ ] Radio-Ausgang `N` → Audio-Player-Eingang `Fav`.
- [ ] Radio-Ausgangs**nummer == Favoriten-ID** in der Loxone-App.
- [ ] Radio-Baustein in *Geräte* als **SCENE_TRIGGER** hinzugefügt.
- [ ] Nach Änderungen **„Alexa, suche nach Geräten"** ausgeführt.
