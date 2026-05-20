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
| **Source / favorites** (ModeController) | Favorites aren't exposed to the Miniserver, and the Audioserver's own favorites API refuses third-party clients (`command not allowed when paired`). Full investigation: [devices.md](devices.md) + project plan. | **Yes** — via the Radio→`Fav` workaround, see [tips.md §2](tips.md#2-starting-audioserver-favorites-by-voice-radiofav-workaround). |
| **Repeat** (ModeController) | The Audio Player control has **no repeat command at all** — the function block itself doesn't support it. | **No.** Nothing to wire to; the Audioserver simply can't repeat by API. |
| **Shuffle** (ToggleController) | The Audio Player control has **no shuffle command at all** — same as repeat. | **No.** Same reason — there is no input or command to drive. |

So: **Source can be worked around** (see §3 and
[tips.md §2](tips.md#2-starting-audioserver-favorites-by-voice-radiofav-workaround)),
but **Repeat and Shuffle cannot be emulated** because the underlying Audio
Player control provides no mechanism for them — not at the Miniserver, not
at the Audioserver. If you need repeat/shuffle on an Audioserver zone, set
it once in the Loxone app; it is not voice-controllable through this
plugin.

---

## 3. Starting Audioserver favorites by voice

For `AudioZoneV2` zones the favorite picker can be rebuilt by wiring a
Loxone **Radio** block to the Audio Player's `Fav` input — the plugin
exposes the Radio block as scenes to Alexa, and each Radio button starts a
zone favorite.

The full step-by-step (wiring, Radio-number ⇔ favorite-ID, exposure as
`SCENE_TRIGGER`) lives in
**[tips.md → Starting Audioserver favorites by voice](tips.md#2-starting-audioserver-favorites-by-voice-radiofav-workaround)**.
The **naming discipline from §1 of this page** applies there 1:1: Radio
outputs that sound like Amazon content will be hijacked by Amazon Music no
matter how correctly they are wired.

---

## 4. Quick checklist

- [ ] Audio transport ("play/pause/next") is unreliable by Alexa design —
      use volume/mute and favorite **activation** instead.
- [ ] Every device name and every favorite/Radio label is a **coined,
      voice-safe name** (not a genre/artist/station/activity word).
- [ ] For AudioZoneV2 favorites: the steps in
      [tips.md §2](tips.md#2-starting-audioserver-favorites-by-voice-radiofav-workaround)
      are in place.
