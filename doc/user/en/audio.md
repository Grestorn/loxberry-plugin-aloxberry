# Audio players & music favorites — caveats and the favorites workaround

[← Back to overview](README.md) · 🇩🇪 [Deutsch](../de/audio.md)

Audio is the one device class where Alexa actively works against you. This
page explains **why**, how to **name things so voice control actually
works**, and a **tested workaround** to start Loxone Audioserver
(`AudioZoneV2`) zone favorites by voice — something the Loxone API does not
otherwise allow.

> See also: [devices.md → Audio rows & limitation note](devices.md) for the
> capability matrix and the underlying Loxone API limitation.

---

## 1. Why Alexa audio is hard (read this first)

Alexa treats music as **its own feature**. When an utterance *looks* like a
music request, Amazon's natural-language understanding routes it to Amazon
Music / its default provider **before** it ever reaches this skill — there is
nothing the plugin can do about that, it happens in Amazon's cloud.

Concretely:

- **"Alexa, play …"**, **"Alexa, pause"**, **"Alexa, next track"** and
  similar transport phrases are very often intercepted by Alexa's own music
  layer instead of being sent to your Loxone zone. This is a platform
  behavior, **not a bug in the plugin**.
- **Volume and mute** are reliable (they are generic device commands, not
  music intents): *"Alexa, set Martins Sound to 30 %"*, *"Alexa, mute
  Martins Sound"*.
- **Favorite/source names matter enormously.** If a favorite is called
  *"Jazz"*, *"Radio"*, *"Pop"*, *"Chill"*, *"Bayern 1"* or anything that
  resembles content Alexa can play itself, saying it out loud will likely
  trigger **Amazon Music**, not your Loxone zone.

### Naming discipline (the single most important thing on this page)

Choose device **and** favorite/scene names that Alexa **cannot** mistake for
its own music catalogue:

| Avoid (Alexa will hijack) | Prefer (voice-safe) |
|---|---|
| "Jazz", "Rock", "Pop", "Chill" | "Mix Eins", "Morgenliste", "Bürofavorit" |
| "Radio", "Radio Bayern", "80s" | "Zone Bad", "Sender A", "Liste Drei" |
| Real station/artist names | A short coined label that is *only* yours |

Rules of thumb:

- Make the name a **coined token**, not a genre, artist, station or activity.
- Keep it **short and unambiguous** (two words max, easy to pronounce).
- Keep it **unique across all rooms** — that name *is* the voice command.
- Prefer **"Alexa, activate \<name\>"** (scene-style) over "play": the
  *activate* verb is far less likely to be swallowed by the music NLU than
  *play*.

---

## 2. What the Audio Player (AudioZoneV2) can't do — and why

The classic **Music Server Zone** (`AudioZone`, the end-of-life Loxone
MusicServer) supports the full audio surface: source/favorite selection,
repeat and shuffle. The plugin exposes these as Alexa **ModeController**
(Source + Repeat) and **ToggleController** (Shuffle).

The newer **Audio Player** (`AudioZoneV2`, the Loxone **Audioserver**) has a
much smaller command set. Per the official Loxone Structure File (v17) an
`AudioZoneV2` zone only understands: `volUp`, `volDown`, `volume`, `tts`,
`playZoneFav`, `prev`, `next`, `play`, `Pause`, `bluetooth`, `presence`.
There is **no `source`/`repeat` command and no `shuffle` command** — those
were V1 MusicServer features that the Audioserver control does not have.

Because of that, the plugin **does not offer ModeController or
ToggleController for `AudioZoneV2`** at all — they are removed from the
device picker and never advertised to Alexa. This is deliberate, not a bug:
showing a Repeat or Shuffle control that the hardware silently ignores would
be worse than not showing it. What remains for `AudioZoneV2` is Power,
Speaker (volume/mute), Playback (play/pause/next/prev) and Playback-state.

| Missing capability | Why it's gone for AudioZoneV2 | Can it be emulated? |
|---|---|---|
| **Source / favorites** (ModeController) | Favorites aren't exposed to the Miniserver, and the Audioserver's own favorites API refuses third-party clients (`command not allowed when paired`). Full investigation: [devices.md](devices.md) + project plan. | **Yes** — via the Radio→`Fav` workaround in §3 below. |
| **Repeat** (ModeController) | The Audio Player control has **no repeat command at all** — the function block itself doesn't support it. | **No.** Nothing to wire to; the Audioserver simply can't repeat by API. |
| **Shuffle** (ToggleController) | The Audio Player control has **no shuffle command at all** — same as repeat. | **No.** Same reason — there is no input or command to drive. |

So: **Source can be worked around** (the rest of this page), but **Repeat
and Shuffle cannot be emulated** because the underlying Audio Player control
provides no mechanism for them — not at the Miniserver, not at the
Audioserver. If you need repeat/shuffle on an Audioserver zone, set it once
in the Loxone app; it is not voice-controllable through this plugin.

---

## 3. Workaround — start Audioserver favorites by voice via a Radio control

The trick: Loxone's **Radio** function block (Radiotasten) has discrete,
labelled outputs. Wire its output to the Audio Player's **`Fav`** input and
each Radio button selects a zone favorite. The plugin already supports the
`Radio` control type, so each labelled button becomes voice-addressable.

You then say:

> **"Alexa, activate \<favorite label from the Radio control\>"**

### 3.1 Wire a Radio block to the Audio Player `Fav` input

In **Loxone Config**, add a **Radio** ("Radiotasten") block and connect its
**`N`** output to the Audio Player's **`Fav`** input:

![Loxone Config: a Radio block ("Musik Favoriten") whose N output is wired into the Audio Player's Fav input](../img/audio-radio-fav-wiring.png)

### 3.2 Label the Radio outputs

Give every Radio output a **voice-safe label** (see §1 — these labels are
exactly what you will say to Alexa). Edit the outputs ("Ausgänge
bearbeiten"):

![Loxone Config "Edit outputs" dialog: each Radio output 1..n has a text label](../img/audio-radio-outputs-config.png)

### 3.3 Match the Radio number to the Loxone favorite **ID**

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

### 3.4 Expose the Radio control to Alexa

In the plugin's **Devices** tab, add the Radio control and expose it as a
**`SCENE_TRIGGER`**. Each labelled output then becomes an Alexa
scene/activity you can trigger by name:

> **"Alexa, activate Morgenliste"** → Radio output with label "Morgenliste"
> → `Fav` = that number → Audioserver plays the favorite with the matching
> ID.

> ⚠️ Apply the **naming discipline from §1** to the Radio labels. A Radio
> output literally named "Bayern 1" or "Jazz" will be hijacked by Amazon
> Music no matter how correctly it is wired. A coined label like
> "Sender Bayern" or "Liste Eins" is what makes the voice command land in
> Loxone.

### 3.5 Limitations of this workaround

- It is a **one-way trigger**: you start a favorite, but Alexa has no
  feedback on which favorite is currently playing (Scene triggers are
  fire-and-forget).
- You are limited to the Radio block's **16 outputs**.
- It needs a small amount of **Loxone Config + Loxone app** setup per zone;
  it is a deliberate user choice, not something the plugin can do for you
  (the favorite names live only on the Audioserver).
- After re-linking Alexa or adding outputs, run **"Alexa, discover
  devices"** so the new scene names are picked up.

---

## 4. Quick checklist

- [ ] Audio transport ("play/pause/next") is unreliable by Alexa design —
      use volume/mute and favorite **activation** instead.
- [ ] Every device, favorite and Radio label is a **coined, voice-safe
      name** (not a genre/artist/station/activity word).
- [ ] Radio block `N` output → Audio Player `Fav` input.
- [ ] Radio output **number == favorite ID** assigned in the Loxone app.
- [ ] Radio control added in *Devices* as **SCENE_TRIGGER**.
- [ ] Ran **"Alexa, discover devices"** after changes.
