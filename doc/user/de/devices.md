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
| **Treppenlicht-Schalter** / zeitgesteuert — `TimedSwitch` | Schalter | Power | Ein/Aus (Loxone steuert den Timer). |
| **Taster** — `Pushbutton` | Szene | Szene | Einmaliger Auslöser: „Alexa, schalte *Name* ein" / in Routinen. |
| **Dimmer** — `Dimmer` | Licht | Power, Helligkeit | Ein/Aus, „stelle *Name* auf 40 %", „dimme *Name*". |
| **Lichtsteuerung** — `LightControllerV2` / `LightController` | Licht | Power, Modus (Lichtszenen) | Ein/Aus, „stelle *Name* auf *Szene*". |
| **Lichtsteuerung / RGB – Farbausgang** — `ColorPickerV2` | Licht | Helligkeit, Farbe, Farbtemperatur | „mache *Name* blau", „warmweiß", Helligkeit 0 = aus. |
| **Automatikbeschattung** — Jalousien, Rollläden, Markisen — `Jalousie` | Innenjalousie | Bereich (Position) | „stelle *Name* auf 50", „öffne/schließe *Name*". |
| **Fenster** (automatisch) — `Window` | Innenjalousie | Bereich (Position) | „stelle *Name* auf 50". |
| **Tor** (Garage/Tor) — `Gate` | Garagentor | Bereich (Position) | Auf eine Position öffnen/schließen. |
| **Virtueller Eingang – Schieberegler** — `Slider` | Sonstiges | Bereich (Wert) | „stelle *Name* auf *N*" innerhalb min/max. |
| **Auswahlschalter +/−** (Wertgeber) — `ValueSelector` | Sonstiges | Bereich (Wert) | Einen Zahlenwert hoch/runter stufen. |
| **Radiotasten** (8× / 16×) — `Radio` | Sonstiges | Modus (benannte Ausgänge) | „stelle *Name* auf *Option*" (einer aktiv). |
| **Sequenzer** (sequenzielle Steuerung) — `Sequential` | Szene | Modus (Programme) | Benanntes Programm starten; erscheint als Szene. |
| **Intelligente Raumregelung** — `IRoomControllerV2` | Thermostat | Thermostat + Temperatursensor | „stelle *Name* auf 21 Grad", „wie ist die Temperatur von *Name*?" |
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
| **Richtung umkehren** | Jalousien, Fenster, Tore, Regler | Wenn 0 % / 100 % entgegengesetzt zu Alexas Erwartung laufen (z. B. ungewöhnlich verdrahtete Jalousie). |
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
