# Tips & how-tos for specific use cases

[← Back to overview](README.md) · 🇩🇪 [Deutsch](../de/tips.md)

A few Loxone controls have voice quirks that aren't obvious — either because
Alexa interferes with its own features, or because a function exists in
Loxone but only becomes voice-addressable through a small detour. This page
collects the most useful tips and workarounds.

> See also: [devices.md](devices.md) for the full Loxone-control → Alexa
> category/capability table, [audio.md](audio.md) for the background on
> why Alexa hijacks music commands, and [presence.md](presence.md) for using
> an Echo's own person/occupancy detection to drive a Loxone state.

---

## 1. Activating light moods (light scenes) by voice

Light moods on a Loxone **Lighting Controller** (`LightControllerV2` or
`LightController`) are forwarded to Alexa as **modes** — every mood you name
in the Loxone app ("Dinner", "TV", "Reading" …) becomes voice-addressable.
Many users miss this because the *Devices* tab only shows "Power" and
"Mode" — no mention of moods.

### 1.1 Expose the Lighting Controller correctly

For Alexa to see the moods, the controller must be exposed with **both**
capabilities **PowerController** *and* **ModeController**, in category
**`LIGHT`**:

![Devices tab: a Lighting Controller with friendly name "Wohnzimmer Lichtsteuerung", category LIGHT, with ModeController and PowerController capabilities ticked](../img/light-modes-device-row.png)

> *PowerController* alone gives you on/off only. The moods you defined in
> Loxone only show up once *ModeController* is also ticked.

After saving, say **"Alexa, discover devices"** so Alexa picks up the new
modes.

### 1.2 Unambiguous mood — the short form

If the mood name is **unique across all exposed Lighting Controllers**
(i.e. no two controllers share that mood name), the short form is enough:

> **"Alexa, activate the *Dinner* mood"** → Alexa sets the matching
> Lighting Controller to the *Dinner* mood.

### 1.3 Ambiguous mood — name the control

If the same mood name exists on **several** Lighting Controllers (e.g.
"Dinner" in both the living room and the dining room), name the control
explicitly:

> **"Alexa, set Wohnzimmer Lichtsteuerung to Dinner"**

This is Alexa's generic mode grammar *"set \<device\> to \<mode\>"*. It
works even when the name would be unique — a reliable fallback if the short
form ever picks the wrong device.

### 1.4 Alexa+ with room context

If you use **Alexa+** and have told the Alexa app which Echo lives in which
room, you can usually just say:

> **"Alexa, activate Dinner"**

Alexa+ ties the room you are speaking from to the Lighting Controller
assigned there — no need to pronounce the control name.

### 1.5 Naming tips

- Keep **mood names short and easy to pronounce** — the name *is* the voice
  command.
- **Moods within one Lighting Controller** must be unique (otherwise the
  plugin only learns about the first one). **Same-named moods on different
  Lighting Controllers** are fine; the cost is that you must say the
  control's name to disambiguate (§1.3).
- Unlike audio (see [audio.md](audio.md)), you do **not** need to avoid
  names that sound like Amazon content — moods are triggered via an Alexa
  mode, not via the music NLU, and therefore do not fall victim to the
  Amazon Music hijack.

---

## 2. Starting Audioserver favorites by voice (Radio→`Fav` workaround)

The **Audio Player** (`AudioZoneV2`, the Loxone **Audioserver**) has zone
favorites, but the Loxone API does not expose them to the Miniserver — so
the plugin cannot offer them as an Alexa source. Background:
[audio.md → What the Audio Player can't do and why](audio.md).

The tested workaround: a Loxone **Radio** function block whose output is
wired to the Audio Player's `Fav` input. Each Radio button then selects a
zone favorite — and the plugin exposes the Radio block as scenes to Alexa,
so each labelled button becomes voice-addressable.

You then say:

> **"Alexa, activate \<favorite label from the Radio block\>"**

### 2.1 Wire a Radio block to the Audio Player `Fav` input

In **Loxone Config**, add a **Radio** ("Radiotasten") block and connect its
**`N`** output to the Audio Player's **`Fav`** input:

![Loxone Config: a Radio block ("Musik Favoriten") whose N output is wired into the Audio Player's Fav input](../img/audio-radio-fav-wiring.png)

### 2.2 Label the Radio outputs

Give every Radio output a **voice-safe label** (see
[audio.md → Naming discipline](audio.md#1-why-alexa-audio-is-hard-read-this-first)
— these labels are exactly what you will say to Alexa). Edit the outputs
("Ausgänge bearbeiten"):

![Loxone Config "Edit outputs" dialog: each Radio output 1..n has a text label](../img/audio-radio-outputs-config.png)

### 2.3 Match the Radio number to the Loxone favorite **ID**

This is the step that makes or breaks it:

- The **Radio** block emits the values **1–16** (output number).
- In the **Loxone app** you can **manually assign an ID** to each zone
  favorite ("Favoriten bearbeiten").
- **The Radio output number must equal the favorite's manually assigned
  ID.** Radio output 4 → the favorite whose ID is 4, etc. If they don't
  line up, the wrong favorite (or none) plays.

![Loxone app "Edit favorites": each favorite shows an ID (1, 2, 3 …) and a type (Playlist / Radio station)](../img/audio-favorites-ids-app.png)

Keep the **Radio label** (what you say) and the **favorite at that ID**
(what plays) in sync. If you reorder favorites in the app, re-check the IDs
against the Radio numbers.

### 2.4 Expose the Radio block to Alexa

In the plugin's **Devices** tab, add the Radio control and expose it as a
**`SCENE_TRIGGER`**. Each labelled output then becomes an Alexa scene you
can trigger by name:

> **"Alexa, activate Morgenliste"** → Radio output labelled "Morgenliste"
> → `Fav` = that number → Audioserver plays the favorite with the matching
> ID.

> ⚠️ **Naming discipline** matters most here: a Radio output literally
> named "Bayern 1" or "Jazz" will be hijacked by Amazon Music no matter how
> correctly it is wired. A coined label like "Sender Bayern" or "Liste
> Eins" is what makes the voice command land in Loxone. Why this happens:
> [audio.md → Why Alexa audio is hard](audio.md).

### 2.5 Limitations of this workaround

- It is a **one-way trigger**: you start a favorite, but Alexa has no
  feedback on which favorite is currently playing (scene triggers are
  fire-and-forget).
- You are limited to the Radio block's **16 outputs**.
- It needs a small amount of **Loxone Config + Loxone app** setup per zone;
  it is a deliberate user choice, not something the plugin can do for you
  (the favorite names live only on the Audioserver).
- After adding or renaming outputs, run **"Alexa, discover devices"** so
  the new scene names are picked up.

---

## Quick checklist

**Light moods**

- [ ] Lighting Controller exposed in the *Devices* tab with **Power + Mode**
      and category **LIGHT**.
- [ ] Ran **"Alexa, discover devices"** after saving.
- [ ] Unique mood → "Alexa, activate the *name* mood".
- [ ] Ambiguous mood → "Alexa, set *control name* to *mood*".

**Audioserver favorites via Radio block**

- [ ] Radio block `N` output → Audio Player `Fav` input.
- [ ] Radio output **number == favorite ID** assigned in the Loxone app.
- [ ] Radio outputs **voice-safe** labels (not a genre/artist/station/
      activity word — see [audio.md](audio.md)).
- [ ] Radio control added in *Devices* as **SCENE_TRIGGER**.
- [ ] Ran **"Alexa, discover devices"** after changes.
