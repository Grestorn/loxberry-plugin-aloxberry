# Gates & garage doors

[← Back to overview](README.md) · 🇩🇪 [Deutsch](../de/gates.md)

A Loxone **Gate** block (the *Garage / Gate* function block — API type `Gate`)
can be handed to Alexa in **two different ways**. They look almost identical in
the *Devices* tab, but they behave very differently: one of them makes Alexa
**ask for a spoken security code before the door opens**.

If the gate guards an entrance to your property, that difference matters. This
page explains both, so you can choose deliberately.

---

## The two ways to expose a gate

| | **Door** *(default)* | **Garage door** *(opt‑in)* |
|---|---|---|
| Alexa category | `DOOR` | `GARAGE_DOOR` |
| Capability | Range (position) | Mode |
| *"Alexa, open \<name\>"* | opens straight away | **Alexa asks for your voice code first** |
| *"Alexa, close \<name\>"* | closes straight away | closes straight away — no code |
| *"Alexa, set \<name\> to 50"* | ✅ any position | ❌ not available |
| **Reverse direction** setting | ✅ | — (not applicable) |
| Available in every Alexa language | ✅ | ⚠️ **not in Dutch** — see below |

Neither option is "more correct". A garden gate that only ever runs fully open
or fully closed is a good fit for **Garage door**. A gate you like to park
half‑open for the dog is better off as a **Door**.

---

## What the voice code is — and who checks it

When a gate is exposed as a **Garage door**, Alexa recognises it as one, and
Amazon applies its own rule for that class of device:

> *"Alexa, open the garage door."*
> *"What is your voice code?"*
> *"One two three four."*
> — and only now does the command travel to your LoxBerry.

The important part is **where the code lives**: entirely in **Amazon's cloud**.
You set it per device in the Alexa app, Amazon checks it, and only after it
matches does anything reach the bridge or your LoxBerry.

- The plugin **never sees the code**, never stores it and cannot check it.
- Neither can the bridge, and neither can anyone who compromised either of
  them — the code simply is not there to steal.
- A failed code means the command is never sent at all. Your Miniserver never
  hears about the attempt.

This is the same mechanism the well‑known commercial garage‑door skills use.
The plugin does not implement the prompt; it only declares the device in the
exact form Alexa recognises, which is what triggers it.

**Setting a code is mandatory.** Amazon requires one before a garage door can
be opened by voice at all — until you set it, Alexa will refuse to open the
door and tell you so.

### Why closing is not protected

Only **opening** is challenged. Closing goes through immediately, on purpose:
being unable to shut your gate because you fumbled a PIN is the more dangerous
failure. The risk being managed here is *someone opening your property*, not
someone closing it.

---

## Switching a gate to garage‑door mode

1. Open the plugin's **Devices** tab and find your gate (filter by type
   `Gate` if the list is long).
2. Set its **Category** to **`GARAGE_DOOR`**. The **Mode** capability ticks
   itself and **Range** clears — the two always travel together, so you only
   ever change one of them.
3. **Save changes.**
4. Say **"Alexa, discover devices"** (or run discovery from the Alexa app).
5. In the **Alexa app**: **Devices → \<your garage door\> → settings (gear
   icon) → Voice code**, and set a **four‑digit code**. The exact wording moves
   around between app versions; look for *Voice code* in that device's own
   settings.
6. Test it: *"Alexa, open \<name\>"*. She should ask for the code.

> **Pick a code you don't use anywhere else** — not your phone PIN, not your
> alarm code, not your card PIN. It gets spoken out loud in a room, which is a
> very different threat model from typing it.

To go back, set the category to `DOOR` and re‑run discovery. If Alexa keeps
showing the old tile, delete the device in the Alexa app and discover again.

---

## What you give up

- **No partial positions.** Alexa's garage door knows only *open* and
  *closed* — there is no "set it to 30 %". This is a limit of Alexa's garage
  door model, not of your Loxone gate: the Loxone app and any Loxone-side
  automation still park it wherever you like.
- **A partly open gate reports "Open".** Anything that is not fully closed
  counts as open, which is what you want for a Routine like *"if the garage
  door is closed, arm the alarm"*.
- **Not available in Dutch.** Amazon supports garage doors in **German,
  English (UK/US), Spanish (ES/US), French and Italian** only. There is no
  Dutch (`nl-NL`) support, so on a Dutch Alexa account the tile appears but
  ignores the spoken verbs. Dutch households should stay on the **Door**
  option, which works in every language.
- **Reverse direction does nothing here.** That setting flips a percentage
  axis; the garage door has no percentages. Open is open. (If a *Door*‑style
  gate opened when you said close, and you fixed it with that checkbox, the fix
  is simply not needed after the switch.)

---

## If Alexa doesn't ask for the code

Work through these in order — the first two cover almost every case:

1. **Is the category really `GARAGE_DOOR`?** Check the *Devices* tab. A gate
   left on `DOOR` behaves like an ordinary opening and is never challenged.
2. **Did you re‑run discovery after saving?** Alexa keeps its own copy of the
   device. Until you say *"Alexa, discover devices"*, it is still using the old
   definition. If it still looks wrong, **delete the device in the Alexa app**
   and discover once more — a stale tile is the usual culprit.
3. **Is a voice code actually set for that device** in the Alexa app? An
   unfinished setup is not the same as no protection: Alexa refuses to open the
   door instead.
4. **Which language is your Alexa account in?** In Dutch the verbs never reach
   the skill at all (see above).

## What the code does *not* cover

The code protects **spoken commands to Alexa**. It is not a lock on your gate:

- The **tile in the Alexa app** belongs to your own signed‑in Amazon account
  and opens the door without a spoken code.
- Whether an **Alexa Routine** can open the door unchallenged is Amazon's
  behaviour, not something this plugin controls. If that matters to you, test
  it once with a Routine of your own before relying on it.
- Everything in **Loxone** — the app, wall buttons, your own automation — is
  untouched. This is purely about the Alexa path.

If you want a hard stop on the Alexa path regardless of codes, use the
plugin's own controls instead: the per‑device **Enabled** checkbox, the
**master off switch**, or the **"pause while a Virtual Status is on"** gate.
See [security.md](security.md).

---

## Which should I choose?

- **An entrance to your property** — driveway gate, garage door, barrier:
  choose **Garage door**. The prompt costs you two seconds and is the whole
  reason this option exists.
- **A gate you position rather than just open** — or a **Dutch** Alexa
  account: choose **Door**.
- **Not sure?** Start with **Garage door**. If the missing percentages annoy
  you, switching back is two clicks and a re‑discovery.

---

See also: **[devices.md](devices.md)** for the full Loxone ↔ Alexa mapping ·
**[security.md](security.md)** for how the rest of the plugin protects you.
