# Presence & person detection with Echo → Loxone

[← Back to overview](README.md) · 🇩🇪 [Deutsch](../de/presence.md)

Modern Echo devices can detect **that someone is in the room** — and, on
camera models, **who** it is — and run an Alexa **Routine** when they do. By
pointing that routine at a Loxone control this plugin exposes, you can turn
"Alexa noticed a person" into a real **state inside Loxone** that your logic
can use, **without any change to the plugin or its code**.

> **What is and isn't the plugin's job here.** The detection and the routine
> live **entirely in the Alexa app / Amazon cloud** — the plugin neither
> creates them nor can see them. The plugin's only role is to give Alexa a
> Loxone **Switch** to flip. Everything below is therefore a *configuration*
> recipe, not a feature you enable in the plugin UI.

> See also: [devices.md](devices.md) for how Loxone controls map to Alexa
> capabilities, and [security.md](security.md) for how commands reach your
> LoxBerry.

---

## 1. What an Echo can detect

Two different mechanisms, with **very different privacy profiles**:

| | Anonymous presence | Identified person |
|---|---|---|
| **Question answered** | "Is *someone* in the room?" | "Is *Alice* in the room?" |
| **How** | Ultrasound (inaudible sound pulse + Doppler echo) and/or other signals | **Visual ID** — on‑device face recognition |
| **Hardware** | Echo (4th gen), Echo Dot (5th gen), Echo Show 10 and newer | Echo Show with a camera, 2021 or newer |
| **Enrollment** | None | Each person enrolls their face once |
| **Routine trigger** | *"When **People are detected**"* (and an inverse "no one for ~7 min") | *"When you see **\<person\>**"* |

> **On‑device.** Both the ultrasound sensing and Visual ID face matching run
> **on the Echo itself** — Amazon states no audio or video is sent to the
> cloud for the detection. What *does* leave the device is the **routine
> action** you attach (e.g. the command that flips your Loxone switch), which
> travels the normal Alexa → bridge → LoxBerry path like any other command.

---

## 2. Decide what you actually want

There are three useful outcomes. Pick one (or combine):

1. **Just notify me** — get a push/announcement when motion is seen. *No
   Loxone and no plugin involved at all* (see §3).
2. **Bring presence into Loxone** — make "someone is in this room" a digital
   state your Loxone program can read (lights, alarm arming, HVAC, logging).
   This is the main reason to involve the plugin (see §4).
3. **Know *who* is present** — same as (2) but per person, using Visual ID on a
   camera Echo Show (see §5).

---

## 3. Notify only (no plugin needed)

In the **Alexa app**, tap **More** (*Mehr*) → **Routines** (*Routinen*) → add a
routine:

- **When:** tap **Smart Home**, pick the **Echo device** that should detect,
  then **Presence** (*Anwesenheit*) → **Person detection** (*Personenerfassung*).
- **Action:** *Send a notification* (push to your phone) and/or *Alexa says* an
  announcement.

That's the whole feature — Aloxberry plays no part. Use this when you only want
to be told, not to drive Loxone.

---

## 4. Bring presence into Loxone (anonymous occupancy)

The idea: expose a **dedicated Loxone Switch** through the plugin, then have an
Alexa Occupancy Routine turn it **on** when people are detected and a second
routine turn it **off** when the room has been empty for a while. Loxone then
holds a clean digital "Echo presence" flag.

### 4.1 Create a Loxone Virtual Input to represent the state

In **Loxone Config**, the simplest and recommended choice is a **Virtual Input**
(*Virtueller Eingang*) — the Miniserver reports it to the plugin as API type
`Switch`, so it behaves exactly like a switch. Add one dedicated to this purpose,
e.g. *"Echo Presence Living Room"*. Its state is your presence flag; feed it
into whatever logic you like (lighting, presence simulation off, alarm,
statistics).

> Use a stateful on/off control (Virtual Input / Switch), **not** a
> push‑button/scene — you want a level that stays on while the room is
> occupied, not a one‑shot pulse.

### 4.2 Expose it in the plugin's *Devices* tab

Add that Virtual Input in **Devices** and select the **SWITCH** category, which
exposes it with the **Power** capability (the default for the `Switch` type —
see [devices.md](devices.md)). Give it a clear friendly name, e.g.
*"Living Room Presence"*. Then say **"Alexa, discover devices"** so the new
switch appears in the Alexa app.

### 4.3 Build the two Alexa routines (in the app)

> **Use the Alexa app, not voice.** Alexa is supposed to let you create
> routines by voice, but in practice that was unreliable (tested on German
> **Alexa+**). Build the routine in the app.

In the **Alexa app**, tap **More** (*Mehr*) → **Routines** (*Routinen*) → add a
new routine, then:

1. **For** (*Für*) — choose whether the routine runs for **a specific person**
   or **everyone**.
2. **When / condition** — tap **Smart Home**. Alexa lists all your smart‑home
   devices **including every Echo**. Select the **Echo device** that should do
   the detecting, then **Presence** (*Anwesenheit*), then pick:
   - **Person detection** (*Personenerfassung*) — fires when a person is present, or
   - **No person detection** (*Keine Personenerfassung*) — the inverse / no‑one case.
3. **Alexa will** (*Alexa wird*) — tap **Smart Home** again and choose **Switch**
   (*Schalter*). Every device you exposed in the **SWITCH** category is listed
   here — pick your **"Living Room Presence"** switch and set it on.

Build **two** routines that share the same Echo under *Presence*:

| Routine | Trigger | Action |
|---|---|---|
| **Presence on** | *Person detection* (*Personenerfassung*) | switch **On** |
| **Presence off** | *No person detection* (*Keine Personenerfassung*) | switch **Off** |

> ⚠️ **The switch does not turn itself off.** The "on" routine only ever
> switches *on*; to clear the flag when the room empties you **must create a
> separate second routine** with the *No person detection* (*Keine
> Personenerfassung*) trigger and a *switch Off* action. Without it the switch
> stays on forever. Alexa fires the no‑one case after the room has had no
> signals for about **7 minutes**.

### 4.4 Use the flag in Loxone

The Loxone Switch now mirrors Echo occupancy. Typical uses:

- Hold hallway/room lighting on while occupied; let it fall back to automatic
  when Routine B clears the flag.
- Combine with Loxone's **own** presence sensors via an OR/AND gate — Echo
  ultrasound is **motion‑biased and room‑level**, so it is best as a
  *supplement*, not the sole source of truth (see *Limitations*).

---

## 5. Know *who* is present (Visual ID)

On a camera **Echo Show (2021+)** with **Visual ID** enrolled, create a
**per‑person** Virtual Input instead of a single occupancy flag:

1. In Loxone Config, add one **Virtual Input** per person you care about — e.g.
   *"Alice present"*, *"Bob present"*.
2. Expose each in the **SWITCH** category in the *Devices* tab; discover devices.
3. In the Alexa app build the routine exactly as in §4.3, but under **For**
   (*Für*) scope it to **a specific person** so person detection resolves to
   that individual, and set the action to turn **that person's** switch on. For
   a clean reset, add a complementary *no person detection* routine that clears
   the per‑person flags — Visual ID has no built‑in "person has left" trigger.

Loxone now has per‑person presence booleans you can use for personalised
scenes, logging, or conditional automation.

> ⚠️ Visual ID is the **most privacy‑sensitive** option in this whole guide:
> it identifies named individuals from a camera. Treat it as strictly opt‑in,
> enroll only people who agree, and prefer the anonymous occupancy flag (§4)
> whenever "who" is not actually needed.

---

## 6. Privacy, control & limitations

In keeping with this plugin's "**you stay in charge**" principle:

- **Detection is opt‑in and local.** An Echo does not emit ultrasound unless a
  presence feature is enabled, and Visual ID requires explicit per‑person
  enrollment. Both match faces / motion **on the device**.
- **You own the routines.** Because the trigger lives in the Alexa app, you can
  see, disable, or delete it there at any time — independently of the plugin.
- **The plugin only ever receives a switch command.** It is never told "a
  person was detected", let alone who; it just sees its exposed Switch being
  turned on or off, exactly like any other Alexa command.
- **Reliability caveats:**
  - Ultrasound occupancy is **room‑level** and **motion‑biased** — sitting very
    still can let it lapse (that is what the ~7‑minute "no one detected" delay
    absorbs). Don't use it alone for safety‑critical logic.
  - The "off" event is **delayed by design** (~7 min). If you need instant
    clearing, combine it with a Loxone presence sensor.
  - Visual ID has **no "person left" trigger** — model "left" via the room's
    *no one detected* event.
- **Whole flow still respects Security.** The on/off command rides the same
  end‑to‑end‑authenticated path as every other command (see
  [security.md](security.md)); the cloud relay still can neither read nor forge
  it.

---

## Quick checklist

**Anonymous occupancy → Loxone**

- [ ] Compatible Echo (4th gen / Dot 5th gen / Show 10 or newer) with presence
      detection enabled.
- [ ] Dedicated Loxone **Virtual Input** created for the presence state.
- [ ] Exposed in *Devices* in the **SWITCH** category; ran **"Alexa, discover
      devices"**.
- [ ] Built **in the app**: Smart Home → Echo → *Presence* → *Person detection*
      → switch **On**.
- [ ] Second routine: same Echo → *No person detection* → switch **Off**.
- [ ] Loxone logic consumes the flag (ideally OR‑combined with a real presence
      sensor).

**Identified person → Loxone**

- [ ] Camera Echo Show (2021+) with **Visual ID** enrolled per person.
- [ ] One Loxone **Virtual Input** per person, each exposed in the **SWITCH**
      category.
- [ ] Routine scoped under **For** to that person → their switch **On**.
- [ ] A *no person detection* routine clears the per‑person flags.
