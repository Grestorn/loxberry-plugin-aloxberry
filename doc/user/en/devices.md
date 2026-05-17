# Loxone ↔ Alexa device mapping

[← Back to overview](README.md) · 🇩🇪 [Deutsch](../de/devices.md)

When you add a Loxone control in the *Devices* tab, the plugin pre‑fills a
sensible **Alexa category** and a set of **capabilities** based on the Loxone
block type. You can adjust both. This page explains what maps to what, and the
consequences of each choice.

---

## A note on Loxone naming

Loxone uses **two different naming schemes**, and this trips everyone up:

- The **function block** name you see in **Loxone Config** / the Loxone app —
  e.g. *Audio Player*, *Automatic Shading*, *Intelligent Room Controller*.
- The **technical type** the Miniserver reports over its API — e.g.
  `AudioZone`, `Jalousie`, `IRoomControllerV2`. **This is the value shown in
  the plugin's *Devices → Type* filter.**

The relationship is **not strictly 1:1**: the same Config block can report
different API types depending on its settings, and different blocks can report
the same type. There is no official mapping table from Loxone — the pairing
below is based on the function-block names from the
[Loxone documentation](https://www.loxone.com/enen/kb-cat/all/) and how this
plugin's code classifies each type. Treat it as a practical guide, and use the
**plugin type** (last part of column 1) as the definitive way to find your
device in the *Devices* tab.

## The mapping table

| Loxone function block (Loxone Config / app) — *plugin type* | Default Alexa category | Capabilities | What you can say / what it does |
|---|---|---|---|
| **Switch** — `Switch` | Switch | Power | "Alexa, turn *name* on/off." |
| **Stairwell Light Switch** / timed switch — `TimedSwitch` | Switch | Power | On/off (Loxone runs its own timer). |
| **Pushbutton** — `Pushbutton` | Scene | Scene | One‑shot trigger: "Alexa, turn on *name*" / use in Routines. |
| **Dimmer** — `Dimmer` | Light | Power, Brightness | On/off, "set *name* to 40 %", "dim *name*". |
| **Lighting Controller** — `LightControllerV2` / `LightController` | Light | Power, Mode (light scenes) | On/off, "set *name* to *scene*". |
| **Lighting / RGB Controller — colour output** — `ColorPickerV2` | Light | Brightness, Color, Color temperature | "make *name* blue", "warm white", brightness 0 = off. |
| **Automatic Shading** — blinds, shutters, awnings — `Jalousie` | Interior blind | Range (position) | "set *name* to 50", "open/close *name*". |
| **Window** (automatic window) — `Window` | Interior blind | Range (position) | "set *name* to 50". |
| **Garage / Gate** — `Gate` | Garage door | Range (position) | Open/close to a position. |
| **Virtual input – slider** — `Slider` | Other | Range (value) | "set *name* to *N*" within its own min/max. |
| **Selection Switch +/−** (value selector) — `ValueSelector` | Other | Range (value) | Step a numeric value up/down. |
| **Radio Buttons** (8× / 16×) — `Radio` | Other | Mode (named outputs) | "set *name* to *option*" (one active at a time). |
| **Sequencer** (sequential controller) — `Sequential` | Scene | Mode (programs) | Start a named program; appears as a Scene. |
| **Intelligent Room Controller** — `IRoomControllerV2` | Thermostat | Thermostat + Temperature sensor | "set *name* to 21 degrees", "what's the temperature of *name*?" |
| **AC Unit Controller** (air conditioning) — `ACControl` | Air conditioner | Power, Thermostat, Temperature sensor, Mode (fan) | Set temperature, heat/cool/auto, fan speed. |
| **Room Ventilation Controller** — `Ventilation` | Fan | Power, Range (speed), Mode (+ optional Temp/Humidity) | On/off, speed, mode (timed override). |
| **Audio Player** — `AudioZone` | Streaming device | Power, Speaker, Playback, Playback state, Toggle, Mode (source) | Volume, mute, play/pause, pick a source. |
| **Music Server Zone** — `AudioZoneV2` | Streaming device | Power, Speaker, Playback, Playback state, Toggle, Mode (source) | Volume, mute, play/pause, pick a source. |
| **Presence** (presence/motion sensor) — `PresenceDetector` | Motion sensor | Motion *(read‑only)* | Status + Routine trigger. |
| **Door and Window Monitor** — `WindowMonitor` | Contact sensor | Contact *(read‑only)* | "Any window open?" + Routine trigger. |
| **Status — digital** (status / virtual status, on/off) — `InfoOnlyDigital` | Contact sensor | Contact / Motion / Mode *(read‑only)* | Read a boolean state; trigger Routines. |
| **Status — analog** (status, numeric) — `InfoOnlyAnalog` | Temperature sensor | Temperature / Humidity *(read‑only)* | Read a numeric value (°C/°F or %). |

> Anything not in this list is **not supported by Alexa** and is hidden by
> default in the picker (you can show it via the "Hide Alexa‑incompatible
> types" filter, but it cannot be exposed).

---

## What the Alexa **category** changes — and why it matters

The category drives the **tile, icon and some voice phrasing** in the Alexa
app. The picker only offers categories that make sense for the chosen Loxone
type, but the choice has real consequences:

- **Scene / Activity trigger** (push-buttons, sequences): Alexa treats it as a
  **Scene**. It is usable by voice and in **Routines**, but it has **no device
  tile**, and you **cannot rename or delete it in the Alexa app**. Choose this
  for momentary actions ("run my movie scene"), not for things you want to see
  and toggle.
- **Every other category** appears as a normal **device tile** you can see and
  control in the app.
- For flexible Loxone blocks (a *Switch* could drive a lamp, an outlet, a fan…)
  pick the category that best matches reality — it only affects the icon and
  how naturally certain phrases work. It does **not** change what the device
  physically does.

## What **capabilities** are

Each capability is one Alexa feature (a checkbox in the picker). Greyed‑out
boxes are features the plugin doesn't implement yet for that type.

| Capability | What it gives you |
|---|---|
| Power | On/off. |
| Brightness | Dim 0–100 %. |
| Color | Full colour (hue/saturation). |
| Color temperature | Warm ↔ cool white. |
| Mode | Selectable named modes/presets (light scenes, fan mode, radio station). |
| Range | A numeric value over a range (blind position, slider). |
| Scene | A one‑shot trigger (push-button / scene). |
| Thermostat | Target temperature + heat/cool mode. |
| Temperature sensor | Reports measured temperature *(read‑only)*. |
| Humidity sensor | Reports relative humidity *(read‑only)*. |
| Speaker | Volume + mute for an audio zone. |
| Playback | Play/pause/stop/next/previous. |
| Motion / Contact sensor | Reports detected/clear or open/closed *(read‑only)*; great as a Routine trigger. |

Some types offer **alternative renderings of the same value** — e.g. a *Digital
status* can be a Contact sensor **or** a Motion sensor **or** a custom‑label
Mode. The picker lets you pick **at most one** of those, because exposing the
same door as two tiles is just confusing.

## Per‑device **Settings** (fine‑tuning)

These appear only for the types they apply to:

| Setting | Applies to | Why you'd change it |
|---|---|---|
| **Reverse direction** | Blinds, windows, gates, sliders | If 0 % / 100 % run opposite to what Alexa expects (e.g. unusually wired blinds). |
| **Override + Hours** | Room controller | Send an Alexa temperature change as a **timed manual override** instead of permanently editing the Loxone schedule. Hours = how long it lasts (1–168). |
| **Step** | Audio zones | How many percent "louder/quieter" moves the volume (1–50). |
| **Invert logic** | Sensors | Swap detected/clear (open/closed) if your contact wiring is reversed. |
| **Duration (h)** | Ventilation | How long an Alexa speed/mode change applies before the Loxone automatic logic resumes (1–168 h). |
| **Active / Inactive labels** | Binary sensors with Mode | Custom words Alexa shows instead of "Detected/Open" — e.g. "Occupied/Vacant", "Wet/Dry". |

---

## How to choose well

- **Read‑only sensors** (presence, window monitor, status blocks) can't be
  *commanded* — their value is for Alexa to **report** and for **Routines** to
  react to ("if motion detected, turn on hallway light").
- **Thermostat override vs. schedule**: leave override **off** if you want
  "Alexa, 22 degrees" to mean "permanently 22"; turn it **on** if you want it
  to be a temporary boost that auto‑expires and lets your Loxone schedule take
  back over.
- **Ventilation** has no "set speed forever" command in Loxone — every Alexa
  change is a timed override (the *Duration* setting). After it expires, the
  ventilation returns to its automatic (humidity/CO₂/presence) logic. This is
  by design, not a bug.
- **Audio Playback**: Alexa often routes "play/pause" to its own music service
  rather than the skill. Volume, mute and source selection are the reliable
  voice operations for Loxone audio zones.
- Keep **friendly names unique** across rooms and easy to pronounce — that name
  *is* the voice command.

After any change, **Save changes**, then say **"Alexa, discover devices"** so
Alexa picks up the new configuration.
