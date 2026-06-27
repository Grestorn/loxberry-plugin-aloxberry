# Anwesenheits- & Personenerkennung mit Echo → Loxone

[← Zurück zur Übersicht](README.md) · 🇬🇧 [English](../en/presence.md)

Moderne Echo-Geräte erkennen, **dass jemand im Raum ist** — und bei
Kamera-Modellen auch, **wer** — und können daraufhin eine Alexa-**Routine**
ausführen. Wenn du diese Routine auf ein Loxone-Control richtest, das dieses
Plugin freigibt, wird aus „Alexa hat eine Person bemerkt" ein echter
**Zustand in Loxone**, den deine Logik nutzen kann — **ohne jede Änderung am
Plugin oder seinem Code**.

> **Was hier Aufgabe des Plugins ist und was nicht.** Die Erkennung und die
> Routine liegen **vollständig in der Alexa-App / Amazon-Cloud** — das Plugin
> erstellt sie nicht und sieht sie nicht. Die einzige Aufgabe des Plugins ist,
> Alexa einen Loxone-**Schalter** zum Umlegen bereitzustellen. Alles Folgende
> ist daher ein *Konfigurations*-Rezept, keine im Plugin-UI aktivierbare
> Funktion.

> Siehe auch: [devices.md](devices.md) für die Zuordnung von Loxone-Controls zu
> Alexa-Fähigkeiten und [security.md](security.md) dafür, wie Befehle deinen
> LoxBerry erreichen.

---

## 1. Was ein Echo erkennen kann

Zwei verschiedene Mechanismen mit **sehr unterschiedlichen Datenschutz-Profilen**:

| | Anonyme Anwesenheit | Identifizierte Person |
|---|---|---|
| **Beantwortete Frage** | „Ist *jemand* im Raum?" | „Ist *Alice* im Raum?" |
| **Wie** | Ultraschall (unhörbarer Schallpuls + Doppler-Echo) und/oder andere Signale | **Visual ID** — Gesichtserkennung auf dem Gerät |
| **Hardware** | Echo (4. Gen.), Echo Dot (5. Gen.), Echo Show 10 und neuer | Echo Show mit Kamera, ab Baujahr 2021 |
| **Einrichtung** | Keine | Jede Person hinterlegt ihr Gesicht einmal |
| **Routinen-Auslöser** | *„Wenn **Personen erkannt werden**"* (und ein Gegenstück „niemand für ~7 Min.") | *„Wenn du **\<Person\>** siehst"* |

> **Auf dem Gerät.** Sowohl die Ultraschall-Erfassung als auch der Visual-ID-
> Gesichtsabgleich laufen **auf dem Echo selbst** — laut Amazon werden für die
> Erkennung weder Audio noch Video in die Cloud gesendet. Was das Gerät
> *verlässt*, ist die angehängte **Routinen-Aktion** (z. B. der Befehl, der
> deinen Loxone-Schalter umlegt); diese nimmt den normalen Weg
> Alexa → Bridge → LoxBerry wie jeder andere Befehl.

---

## 2. Was willst du eigentlich erreichen?

Es gibt drei sinnvolle Ergebnisse. Wähle eines (oder kombiniere):

1. **Nur benachrichtigen** — eine Push-Nachricht/Ansage erhalten, wenn Bewegung
   erkannt wird. *Ohne Loxone und ohne Plugin* (siehe §3).
2. **Anwesenheit nach Loxone bringen** — „jemand ist in diesem Raum" zu einem
   digitalen Zustand machen, den dein Loxone-Programm lesen kann (Licht,
   Alarm-Scharfschaltung, Heizung/Lüftung, Protokollierung). Das ist der
   Hauptgrund, das Plugin einzubeziehen (siehe §4).
3. **Wissen, *wer* anwesend ist** — wie (2), aber pro Person, mittels Visual ID
   auf einem Echo Show mit Kamera (siehe §5).

---

## 3. Nur benachrichtigen (kein Plugin nötig)

In der **Alexa-App** auf **Mehr** → **Routinen** → eine Routine hinzufügen:

- **Wenn:** auf **Smart Home** tippen, das **Echo-Gerät** wählen, das erkennen
  soll, dann **Anwesenheit** → **Personenerfassung**.
- **Aktion:** *Benachrichtigung senden* (Push aufs Handy) und/oder *Alexa sagt*
  eine Ansage.

Das ist die ganze Funktion — Aloxberry ist nicht beteiligt. Nutze dies, wenn du
nur informiert werden, aber Loxone nicht ansteuern willst.

---

## 4. Anwesenheit nach Loxone bringen (anonyme Belegung)

Die Idee: einen **eigenen Loxone-Schalter** über das Plugin freigeben, und eine
Alexa-Belegungs-Routine schaltet ihn **ein**, wenn Personen erkannt werden, und
eine zweite Routine schaltet ihn **aus**, wenn der Raum eine Weile leer war.
Loxone hält dann ein sauberes digitales „Echo-Anwesenheit"-Flag.

### 4.1 Einen Loxone-Virtuellen-Eingang für den Zustand anlegen

In **Loxone Config** ist die einfachste und empfohlene Wahl ein **Virtueller
Eingang** — der Miniserver meldet ihn dem Plugin als API-Typ `Switch`, er
verhält sich also genau wie ein Schalter. Lege einen eigens für diesen Zweck an,
z. B. *„Echo Anwesenheit Wohnzimmer"*. Sein Zustand ist dein
Anwesenheits-Flag; führe ihn in beliebige Logik (Licht, Anwesenheitssimulation
aus, Alarm, Statistik).

> Verwende ein zustandsbehaftetes Ein/Aus-Control (Virtueller Eingang /
> Schalter), **keinen** Taster/keine Szene — du willst einen Pegel, der während
> der Belegung anliegt, keinen einmaligen Impuls.

### 4.2 Im Plugin-Tab *Geräte* freigeben

Füge diesen Virtuellen Eingang unter **Geräte** hinzu und wähle die Kategorie
**SWITCH** (Schalter), die ihn mit der Fähigkeit **Power** freigibt (Standard
für den Typ `Switch` — siehe [devices.md](devices.md)). Gib ihm einen klaren
Anzeigenamen, z. B. *„Wohnzimmer Anwesenheit"*. Sage dann **„Alexa, suche
Geräte"**, damit der neue Schalter in der Alexa-App erscheint.

### 4.3 Die beiden Alexa-Routinen bauen (in der App)

> **Nutze die Alexa-App, nicht die Sprache.** Eigentlich sollte sich eine
> Routine auch per Sprache anlegen lassen, in der Praxis war das aber unzuverlässig
> (getestet mit deutschem **Alexa+**). Erstelle die Routine in der App.

Tippe in der **Alexa-App** auf **Mehr** → **Routinen** → eine neue Routine
hinzufügen, dann:

1. **Für** — wähle, ob die Routine für **eine bestimmte Person** oder **alle**
   gilt.
2. **Wenn / Bedingung** — tippe auf **Smart Home**. Alexa listet alle deine
   Smart-Home-Geräte **inklusive aller Echos** auf. Wähle das **Echo-Gerät**,
   das erkennen soll, dann **Anwesenheit**, dann:
   - **Personenerfassung** — löst aus, wenn eine Person anwesend ist, oder
   - **Keine Personenerfassung** — der umgekehrte Fall / niemand anwesend.
3. **Alexa wird** — tippe erneut auf **Smart Home** und wähle **Schalter**.
   Jedes Gerät, das du in der Kategorie **SWITCH** freigegeben hast, ist hier
   gelistet — wähle deinen Schalter **„Wohnzimmer Anwesenheit"** und stelle ihn
   auf An.

Baue **zwei** Routinen, die denselben Echo unter *Anwesenheit* nutzen:

| Routine | Auslöser | Aktion |
|---|---|---|
| **Anwesenheit ein** | *Personenerfassung* | Schalter **An** |
| **Anwesenheit aus** | *Keine Personenerfassung* | Schalter **Aus** |

> ⚠️ **Der Schalter geht nicht von selbst aus.** Die „Ein"-Routine schaltet nur
> *ein*; um das Flag beim Verlassen des Raums zu löschen, **musst du eine
> separate zweite Routine** mit dem Auslöser *Keine Personenerfassung* und der
> Aktion *Schalter Aus* anlegen. Ohne sie bleibt der Schalter dauerhaft an.
> Alexa löst den Niemand-Fall aus, nachdem der Raum etwa **7 Minuten** keine
> Signale hatte.

### 4.4 Das Flag in Loxone nutzen

Der Loxone-Schalter spiegelt nun die Echo-Belegung. Typische Verwendungen:

- Flur-/Raumlicht eingeschaltet halten, solange belegt; bei Löschen durch
  Routine B auf die Automatik zurückfallen lassen.
- Mit Loxones **eigenen** Präsenzmeldern über ein ODER/UND-Gatter kombinieren —
  Echo-Ultraschall ist **bewegungslastig und raumbezogen** und eignet sich
  daher am besten als *Ergänzung*, nicht als alleinige Wahrheitsquelle (siehe
  *Einschränkungen*).

---

## 5. Wissen, *wer* anwesend ist (Visual ID)

Auf einem Kamera-**Echo Show (ab 2021)** mit eingerichteter **Visual ID** legst
du statt eines einzelnen Belegungs-Flags einen **Virtuellen Eingang pro Person**
an:

1. Lege in Loxone Config je einen **Virtuellen Eingang** pro relevanter Person
   an — z. B. *„Alice anwesend"*, *„Bob anwesend"*.
2. Gib jeden in der Kategorie **SWITCH** im Tab *Geräte* frei; Geräte suchen
   lassen.
3. Baue in der Alexa-App die Routine genau wie in §4.3, aber begrenze sie unter
   **Für** auf **eine bestimmte Person**, sodass die Personenerfassung diese
   Person auflöst, und stelle als Aktion den Schalter **dieser Person** auf An.
   Für ein sauberes Zurücksetzen ergänze eine *Keine Personenerfassung*-Routine,
   die die Personen-Flags löscht — Visual ID hat keinen eingebauten Auslöser
   „Person hat den Raum verlassen".

Loxone hat nun pro Person ein Anwesenheits-Boolean für personalisierte Szenen,
Protokollierung oder bedingte Automation.

> ⚠️ Visual ID ist die **datenschutzsensibelste** Option dieser ganzen
> Anleitung: Sie identifiziert namentlich genannte Personen per Kamera.
> Behandle sie als ausdrücklich opt-in, hinterlege nur einverstandene Personen
> und bevorzuge das anonyme Belegungs-Flag (§4), wann immer das „Wer" nicht
> wirklich gebraucht wird.

---

## 6. Datenschutz, Kontrolle & Einschränkungen

Im Sinne des Grundsatzes „**Du behältst die Kontrolle**" dieses Plugins:

- **Erkennung ist opt-in und lokal.** Ein Echo sendet keinen Ultraschall, sofern
  keine Anwesenheitsfunktion aktiviert ist, und Visual ID erfordert das
  ausdrückliche Hinterlegen pro Person. Beides gleicht Gesichter / Bewegung
  **auf dem Gerät** ab.
- **Die Routinen gehören dir.** Da der Auslöser in der Alexa-App liegt, kannst du
  ihn dort jederzeit sehen, deaktivieren oder löschen — unabhängig vom Plugin.
- **Das Plugin empfängt nur einen Schalterbefehl.** Ihm wird nie mitgeteilt,
  „eine Person wurde erkannt", geschweige denn wer; es sieht nur, dass sein
  freigegebener Schalter ein- oder ausgeschaltet wird — genau wie bei jedem
  anderen Alexa-Befehl.
- **Zuverlässigkeits-Hinweise:**
  - Die Ultraschall-Belegung ist **raumbezogen** und **bewegungslastig** — sehr
    ruhiges Sitzen kann sie verfallen lassen (das fängt die ~7-minütige
    „Niemand erkannt"-Verzögerung ab). Nutze sie nicht allein für
    sicherheitskritische Logik.
  - Das „Aus"-Ereignis ist **bewusst verzögert** (~7 Min.). Brauchst du
    sofortiges Löschen, kombiniere es mit einem Loxone-Präsenzmelder.
  - Visual ID hat **keinen „Person hat den Raum verlassen"-Auslöser** — bilde
    „verlassen" über das *Niemand erkannt*-Ereignis des Raums ab.
- **Der gesamte Ablauf wahrt die Sicherheit.** Der Ein/Aus-Befehl nimmt denselben
  Ende-zu-Ende-authentifizierten Weg wie jeder andere Befehl (siehe
  [security.md](security.md)); der Cloud-Vermittler kann ihn weiterhin weder
  lesen noch fälschen.

---

## Kurz-Checkliste

**Anonyme Belegung → Loxone**

- [ ] Kompatibler Echo (4. Gen. / Dot 5. Gen. / Show 10 oder neuer) mit
      aktivierter Anwesenheitserkennung.
- [ ] Eigener Loxone-**Virtueller Eingang** für den Anwesenheitszustand angelegt.
- [ ] Unter *Geräte* in der Kategorie **SWITCH** freigegeben; **„Alexa, suche
      Geräte"** ausgeführt.
- [ ] **In der App** gebaut: Smart Home → Echo → *Anwesenheit* →
      *Personenerfassung* → Schalter **An**.
- [ ] Zweite Routine: derselbe Echo → *Keine Personenerfassung* → Schalter **Aus**.
- [ ] Loxone-Logik nutzt das Flag (idealerweise ODER-verknüpft mit einem echten
      Präsenzmelder).

**Identifizierte Person → Loxone**

- [ ] Kamera-Echo-Show (ab 2021) mit pro Person eingerichteter **Visual ID**.
- [ ] Je ein Loxone-**Virtueller Eingang** pro Person, jeweils in der Kategorie
      **SWITCH** freigegeben.
- [ ] Routine unter **Für** auf diese Person begrenzt → Schalter dieser Person **An**.
- [ ] Eine *Keine Personenerfassung*-Routine löscht die Personen-Flags.
