# Loxone-↔-Alexa-Gerätezuordnung

[← Zurück zur Übersicht](README.md) · 🇬🇧 [English](../en/devices.md)

Wenn du im Tab *Geräte* ein Loxone-Control hinzufügst, füllt das Plugin anhand
des Loxone-Bausteintyps eine sinnvolle **Alexa-Kategorie** und einen Satz
**Fähigkeiten** vor. Beides kannst du anpassen. Diese Seite erklärt, was worauf
abgebildet wird und welche Folgen jede Wahl hat.

---

## Ein Hinweis zur Loxone-Benennung

Loxone verwendet **zwei verschiedene Namensschemata** — das verwirrt jeden:

- Der **Funktionsbaustein**-Name, den du in **Loxone Config** / der Loxone-App
  siehst — z. B. *Music Server Zone*, *Automatikbeschattung*, *Intelligente
  Raumregelung*.
- Der **technische Typ**, den der Miniserver über seine API meldet — z. B.
  `AudioZone`, `Jalousie`, `IRoomControllerV2`. **Dieser Wert wird im Plugin
  unter *Geräte → Typ*-Filter angezeigt.**

Die Beziehung ist **nicht streng 1:1**: Derselbe Config-Baustein kann je nach
Einstellungen unterschiedliche API-Typen melden, und verschiedene Bausteine
können denselben Typ melden. Es gibt von Loxone keine offizielle
Zuordnungstabelle — die Paarung unten basiert auf den Funktionsbaustein-Namen
aus der [Loxone-Dokumentation](https://www.loxone.com/dede/kb-cat/config-functionblock/)
und darauf, wie der Code dieses Plugins jeden Typ einordnet. Sieh es als
praktischen Leitfaden und nutze den **Plugin-Typ** (letzter Teil der Spalte 1)
als definitiven Weg, dein Gerät im Tab *Geräte* zu finden.

## Die Zuordnungstabelle

| Loxone-Funktionsbaustein (Loxone Config / App) — *Plugin-Typ* | Standard-Alexa-Kategorie | Fähigkeiten | Was du sagst / was es tut |
|---|---|---|---|
| **Schalter** — `Switch` | Schalter | Power | „Alexa, schalte *Name* ein/aus." |
| **Treppenlicht-Schalter** / Komfortschalter — `TimedSwitch` | Schalter | Power **oder** Szene | Ein/Aus. Zwei Wege zum Loxone-Timer: (a) **Power** behalten und **Timer auslösen / Umschalten mit Timer** anhaken (siehe Einstellungen unten); oder (b) als **Szene** nutzen — entweder die Fähigkeit **Szene** anhaken *oder* eine `SCENE_TRIGGER`/`ACTIVITY_TRIGGER`-Kategorie wählen, der Picker stellt das jeweils andere passend um — sodass jedes „Alexa, schalte *Name* ein" einfach den Timer auslöst: zustandslos und beliebig oft wiederholbar, wie ein Tastendruck. |
| **Taster** — `Pushbutton` | Szene | Szene | Einmaliger Auslöser: „Alexa, schalte *Name* ein" / in Routinen. |
| **Dimmer** — `Dimmer` | Licht | Power, Helligkeit | Ein/Aus, „stelle *Name* auf 40 %", „dimme *Name*". |
| **Lichtsteuerung** — `LightControllerV2` / `LightController` | Licht | Power, Modus (Lichtszenen) | Ein/Aus, „stelle *Name* auf *Szene*". |
| **Lichtsteuerung / RGB – Farbausgang** — `ColorPickerV2` | Licht | Helligkeit, Farbe, Farbtemperatur | „mache *Name* blau", „warmweiß", Helligkeit 0 = aus. |
| **Automatikbeschattung** — Jalousien, Rollläden, Markisen — `Jalousie` | Innenjalousie | Bereich (Position) | „stelle *Name* auf 50", „öffne/schließe/fahre *Name* hoch/runter". |
| **Fenster** (automatisch) — `Window` | Innenjalousie | Bereich (Position) | „stelle *Name* auf 50", „öffne/schließe *Name*". |
| **Tor** (Garage/Tor) — `Gate` | Tür | Bereich (Position) — **oder** Modus | „öffne/schließe *Name*" oder auf eine Position fahren. Stellst du es auf die Kategorie `GARAGE_DOOR` um, **fragt Alexa vor dem Öffnen nach einem gesprochenen Sicherheitscode** — siehe **[gates.md](gates.md)**. |
| **Virtueller Eingang – Schieberegler** — `Slider` | Sonstiges | Bereich (Wert) | „stelle *Name* auf *N*" innerhalb min/max. |
| **Auswahlschalter +/−** (Wertgeber) — `ValueSelector` | Sonstiges | Bereich (Wert) | Einen Zahlenwert hoch/runter stufen. |
| **Radiotasten** (8× / 16×) — `Radio` | Sonstiges | Modus (benannte Ausgänge) | „stelle *Name* auf *Option*" (einer aktiv). |
| **Sequenzer** (sequenzielle Steuerung) — `Sequential` | Szene | Modus (Programme) | Benanntes Programm starten; erscheint als Szene. |
| **Intelligente Raumregelung** — `IRoomControllerV2` | Thermostat | Thermostat + Temperatursensor (+ optional Feuchte) | „stelle *Name* auf 21 Grad", „wie ist die Temperatur von *Name*?" |
| **Klimaanlagensteuerung** — `ACControl` | Klimaanlage | Power, Thermostat, Temperatursensor, Modus (Lüfter) | Temperatur, Heizen/Kühlen/Auto, Lüfterstufe. |
| **Raumlüftungssteuerung** — `Ventilation` | Lüfter | Power, Bereich (Stufe), Modus (+ optional Temp/Feuchte) | Ein/Aus, Stufe, Modus (zeitlich begrenzt). |
| **Music Server Zone** (Loxone MusicServer, abgekündigt) — `AudioZone` | Streaming-Gerät | Power, Lautsprecher, Wiedergabe, Wiedergabestatus, Schalter, Modus (Quelle) | Lautstärke, Stumm, Play/Pause, Zonenfavorit per Name wählen. |
| **Audio Player** (Loxone Audioserver) — `AudioZoneV2` | Streaming-Gerät | Power, Lautsprecher, Wiedergabe, Wiedergabestatus, Schalter | Lautstärke, Stumm, Play/Pause. **Keine Favoritenwahl** — siehe Hinweis unten. |
| **Präsenz** (Präsenz-/Bewegungsmelder) — `PresenceDetector` | Bewegungssensor | Bewegung *(nur lesend)* | Status + Routinen-Auslöser. |
| **Fenster- und Türüberwachung** — `WindowMonitor` | Kontaktsensor | Kontakt *(nur lesend)* | „Ist ein Fenster offen?" + Routinen-Auslöser. |
| **Status – digital** (Status / Virtueller Status, Ein/Aus) — `InfoOnlyDigital` | Kontaktsensor | Kontakt / Bewegung / Modus *(nur lesend)* | Booleschen Zustand lesen; Routinen auslösen. |
| **Status – analog** (Status, numerisch) — `InfoOnlyAnalog` | Temperatursensor | Temperatur / Feuchte *(nur lesend)* | Zahlenwert lesen (°C/°F oder %). |

> Alles, was nicht in dieser Liste steht, wird **von Alexa nicht unterstützt**
> und ist im Picker standardmäßig ausgeblendet (über den Filter „Nicht von
> Alexa unterstützte Typen ausblenden" sichtbar, aber nicht freigebbar).

### „Öffnen" und „Schließen" zu Jalousien, Fenstern und Toren sagen

Jalousien (`Jalousie`), Fenster (`Window`) und Tore (`Gate`) verstehen neben der
Prozentangabe auch die einfachen Verben:

- **„Alexa, öffne / schließe *Name*"** — fährt ganz auf (100 %) bzw. ganz zu
  (0 %).
- **„Alexa, fahre *Name* hoch / runter"** — dasselbe wie öffnen / schließen
  (praktisch bei Jalousien).
- **„Alexa, stelle *Name* auf 50"** — jede Position dazwischen.

Auch „mach *Name* auf/zu" funktioniert. Alexa übersetzt diese Verben
automatisch in die passenden Wörter deiner Sprache — du konfigurierst nichts.

Zwei Dinge solltest du wissen:

- Wenn **Auf und Zu vertauscht sind** (Öffnen schließt die Jalousie und
  umgekehrt), hake bei diesem Gerät unter Einstellungen **Richtung umkehren** an
  — siehe Tabelle unten. Damit dreht sich auch die Prozentachse passend mit.
- Die Verben erscheinen erst **nach einer erneuten Suche**: Sage nach dem
  Plugin-Update einmal **„Alexa, suche Geräte"**, sonst reagiert eine bereits
  bekannte Jalousie weiterhin nur auf Prozentangaben.

Beim **Tor** lohnt sich beim schlichten „öffne" ein zweiter Gedanke: Als
`GARAGE_DOOR` statt als `DOOR` freigegeben, fragt Alexa vor dem Öffnen nach
einem **gesprochenen Sicherheitscode** (vor dem Schließen nie). Das ist eine
Entscheidung je Gerät mit echten Abwägungen — **[gates.md](gates.md)** erklärt
beide Varianten und die Einrichtung des Codes.

### Lichtsteuerungen geben jeden Lichtkanal einzeln frei — plus einen „Master"

Eine Loxone-**Lichtsteuerung** (`LightControllerV2` / `LightController`) ist im
Tab *Geräte* nicht ein einzelnes Gerät. Loxone veröffentlicht die Steuerung
**und jeden ihrer Lichtkanäle** (die einzelnen Lichtkreise/Ausgänge) als
separate Controls, und das Plugin listet jedes davon als eigenes auswählbares
Gerät:

- **Die Steuerung selbst** — freigegeben mit **Power + Modus**, sodass du ihre
  **Lichtstimmungen/-szenen** („Essen", „TV" …) per Sprache steuerst (siehe
  [tips.md → Lichtstimmungen aktivieren](tips.md#1-lichtstimmungen-lichtszenen-per-sprache-aktivieren)).
- **Ein Eintrag pro Lichtkanal** — jeder Lichtkreis erscheint als eigener
  `Switch` (bzw. `Dimmer`/`ColorPickerV2`, je nach Kanal), sodass du ein
  einzelnes Licht der Steuerung gezielt ansprechen kannst.
- **Ein „Master"-Kanal** — Loxone erzeugt zusätzlich ein Control für alle
  Kanäle, meist **„Master-Schalter"** genannt. Schaltest du es ein oder aus,
  gehen **alle Kanäle dieser Steuerung gemeinsam** an oder aus. Es ist ein
  gewöhnlicher `Switch` wie die anderen — deshalb taucht es auf, wenn du im
  Picker nach *Master* filterst.

Diese Kanal- und Master-Einträge **erben Raum und Kategorie der Steuerung** und
stehen im Picker daher bei ihrer Lichtsteuerung gruppiert. **Du entscheidest,
was du freigibst** — nichts wird automatisch an Alexa übergeben. Füge die
*Steuerung* für Stimmungen hinzu, einzelne *Kanäle* für die Steuerung einzelner
Lichter und/oder den *Master* für „die ganze Steuerung ein/aus". Falls in Alexa
unerwartet ein „Master-Schalter" auftauchte, wurde dieser Subcontrol im Tab
*Geräte* hinzugefügt — entferne oder deaktiviere ihn dort und führe erneut
**„Alexa, suche Geräte"** aus.

---

## Was die Alexa-**Kategorie** ändert — und warum das wichtig ist

Die Kategorie steuert **Kachel, Symbol und einen Teil der Sprachformulierung**
in der Alexa-App. Der Picker bietet nur Kategorien an, die zum gewählten
Loxone-Typ passen — die Wahl hat aber echte Folgen:

- **Szene / Aktivität** (Taster, Sequenzen): Alexa behandelt es als **Szene**.
  Per Sprache und in **Routinen** nutzbar, aber **ohne Gerätekachel**, und es
  lässt sich **in der Alexa-App nicht umbenennen oder löschen**. Wähle das für
  einmalige Aktionen („starte meine Filmszene"), nicht für Dinge, die du sehen
  und umschalten willst.
- **Jede andere Kategorie** erscheint als normale **Gerätekachel**, sicht- und
  steuerbar in der App.
- Bei flexiblen Loxone-Bausteinen (ein *Schalter* kann eine Lampe, eine
  Steckdose, einen Lüfter … treiben) wähle die Kategorie, die der Realität am
  nächsten kommt — sie beeinflusst nur Symbol und natürliche Sprachphrasen.
  Sie ändert **nicht**, was das Gerät physisch tut.

## Was **Fähigkeiten** sind

Jede Fähigkeit ist eine Alexa-Funktion (eine Checkbox im Picker). Ausgegraute
Boxen sind Funktionen, die das Plugin für diesen Typ noch nicht umsetzt.

| Fähigkeit | Was du bekommst |
|---|---|
| Power | Ein/Aus. |
| Helligkeit | Dimmen 0–100 %. |
| Farbe | Volle Farbe (Farbton/Sättigung). |
| Farbtemperatur | Warm ↔ kühl weiß. |
| Modus | Auswählbare benannte Modi/Voreinstellungen (Lichtszenen, Lüftermodus, Radiosender). |
| Bereich | Ein Zahlenwert über einen Bereich (Jalousieposition, Regler). |
| Szene | Ein einmaliger Auslöser (Taster / Szene). |
| Thermostat | Zieltemperatur + Heiz-/Kühlmodus. |
| Temperatursensor | Meldet gemessene Temperatur *(nur lesend)*. |
| Feuchtesensor | Meldet relative Luftfeuchte *(nur lesend)*. |
| Lautsprecher | Lautstärke + Stumm einer Audiozone. |
| Wiedergabe | Play/Pause/Stopp/weiter/zurück. |
| Bewegungs-/Kontaktsensor | Meldet erkannt/frei bzw. offen/geschlossen *(nur lesend)*; ideal als Routinen-Auslöser. |

Manche Typen bieten **alternative Darstellungen desselben Werts** — z. B. kann
ein *Digitaler Status* ein Kontaktsensor **oder** ein Bewegungssensor **oder**
ein Modus mit eigenen Bezeichnungen sein. Der Picker lässt **höchstens eine**
davon zu, denn dieselbe Tür als zwei Kacheln ist nur verwirrend.

## Gerätespezifische **Einstellungen** (Feinjustierung)

Diese erscheinen nur bei den Typen, für die sie gelten:

| Einstellung | Gilt für | Warum ändern |
|---|---|---|
| **Richtung umkehren** | Jalousien, Fenster, Tore, Regler | Wenn 0 % / 100 % entgegengesetzt zu Alexas Erwartung laufen (z. B. ungewöhnlich verdrahtete Jalousie). Gilt nicht für ein Tor, das als **Garagentor** freigegeben ist — dieses hat keine Prozentachse. |
| **Timer auslösen** / **Umschalten mit Timer** | Zeitgesteuerter Schalter | Lässt „Alexa, einschalten" den Loxone-Timer auslösen, statt dauerhaft einzuschalten. Beim **Treppenlicht-Schalter** geht das Licht für die eingestellte Zeit an und dann von selbst aus („Timer auslösen"). Beim **Komfortschalter** schaltet derselbe Befehl ein (mit Timer), wenn es aus ist, und aus, wenn es bereits an ist („Umschalten mit Timer"). „Ausschalten" schaltet immer sofort aus. Die Timer-Dauer wird in Loxone Config eingestellt. |
| **Überschreibung + Stunden** | Raumregler | Eine Alexa-Temperaturänderung als **zeitlich begrenzte Übersteuerung** senden statt den Loxone-Zeitplan dauerhaft zu ändern. Stunden = Dauer (1–168). |
| **Schritt** | Audiozonen | Um wie viel Prozent „lauter/leiser" die Lautstärke ändert (1–50). |
| **Logik umkehren** | Sensoren | Erkannt/frei (offen/geschlossen) tauschen, wenn dein Kontakt invertiert verdrahtet ist. |
| **Dauer (Std.)** | Lüftung | Wie lange eine Alexa-Stufen-/Modusänderung gilt, bevor die Loxone-Automatik wieder greift (1–168 Std.). |
| **Aktiv-/Inaktiv-Bezeichnung** | Binärsensoren mit Modus | Eigene Wörter statt „Erkannt/Offen" — z. B. „Belegt/Frei", „Nass/Trocken". |

---

## So triffst du eine gute Wahl

- **Nur-lesende Sensoren** (Präsenz, Fensterüberwachung, Statusbausteine)
  lassen sich nicht *steuern* — ihr Wert dient Alexa zum **Melden** und
  **Routinen** zum Reagieren („wenn Bewegung erkannt, Flurlicht an").
- **Thermostat: Übersteuerung vs. Zeitplan**: Übersteuerung **aus** lassen,
  wenn „Alexa, 22 Grad" dauerhaft 22 bedeuten soll; **ein**, wenn es ein
  vorübergehender Schub sein soll, der automatisch ausläuft und den
  Loxone-Zeitplan wieder übernehmen lässt.
- **Lüftung** hat in Loxone keinen Befehl „Stufe dauerhaft setzen" — jede
  Alexa-Änderung ist eine zeitlich begrenzte Übersteuerung (Einstellung
  *Dauer*). Danach kehrt die Lüftung in die Automatik (Feuchte/CO₂/Präsenz)
  zurück. Das ist so gewollt, kein Fehler.
- **Audio-Wiedergabe**: Alexa leitet „Play/Pause" oft an den eigenen
  Musikdienst statt an den Skill. Verlässlich per Sprache sind Lautstärke
  und Stummschaltung für Loxone-Audiozonen.
- **Audioserver-Favoriten (AudioZoneV2) nicht verfügbar
  (Loxone-API-Einschränkung)**: Loxone hatte zwei Audio-Produkte. Der ältere
  **MusicServer** (mittlerweile abgekündigt, basierend auf Logitechs ebenfalls
  eingestellter SqueezeBox-Technik) ist der Funktionsbaustein **Music Server
  Zone** — API-Typ `AudioZone` — und stellt seine Zonenfavoriten **bereit**;
  du kannst also sagen *„stelle die Quelle von \<Zone\> auf \<Favoritname\>"*.
  Sein von Loxone selbst entwickelter Nachfolger, der **Audioserver** (der
  Funktionsbaustein **Audio Player** — API-Typ `AudioZoneV2`),
  kann das **nicht**: Der Miniserver veröffentlicht die
  Favoritenliste für Audioserver-Zonen schlicht nicht (laut offizieller
  Loxone-Strukturdatei ist die Audioserver-Favoriten-API „nicht öffentlich
  verfügbar"). Das Plugin kann die Favoritennamen nicht ermitteln und bietet für
  `AudioZoneV2`-Zonen daher bewusst **keine** Quellenauswahl an, statt sinnlose
  „Source 1–8"-Einträge anzuzeigen. Power, Lautstärke, Stumm und Play/Pause
  funktionieren weiterhin. Eine Favoritenwahl für Audioserver-Zonen wird ggf.
  später über eine direkte Audioserver-Anbindung möglich; dies ist als bekannte
  Einschränkung vermerkt. **Es gibt einen erprobten Workaround** (ein
  Loxone-Radio-Baustein am `Fav`-Eingang des Audio Players, als Szene
  freigegeben) — die Schritt-für-Schritt-Anleitung steht in
  **[tips.md → Audioserver-Favoriten per Sprache starten](tips.md#2-audioserver-favoriten-per-sprache-starten-radiofav-workaround)**.
  Warum Alexa Musikbefehle generell kapert und wie man sprachsichere Namen
  wählt, erklärt **[audio.md](audio.md)**.
- **Anzeigenamen** über Räume hinweg eindeutig und gut aussprechbar halten —
  dieser Name *ist* der Sprachbefehl.

Nach jeder Änderung **Änderungen speichern** und dann **„Alexa, suche nach
Geräten"** sagen, damit Alexa die neue Konfiguration übernimmt.
