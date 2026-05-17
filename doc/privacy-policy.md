# Aloxberry — Privacy Policy

**Effective date:** 2026-05-17
**Operator / data controller:** Martin Korndörfer, Germany
**Contact:** martin@korndoerfer.de

Aloxberry is an open-source LoxBerry plugin and Amazon Alexa Smart Home skill
that lets you control your own Loxone home-automation devices by voice. This
policy describes what data the skill processes and why. It is intentionally
minimal because the skill is designed to process as little data as possible.

## What the skill processes

When you link the skill to your Amazon account, the following is processed:

- **An Amazon authorization token** (a "Login with Amazon" refresh token),
  used **only** to send proactive device-state updates to your Alexa account.
  Your Amazon password is never seen or stored.
- **A randomly generated account identifier and a per-account signing secret**,
  generated locally by your LoxBerry, used solely to authenticate messages
  between your installation and the skill backend.
- **The names, types, and current state** (e.g. on/off, brightness,
  temperature) **of the Loxone devices you choose to expose** — required to
  present them to Alexa and to carry out your voice commands.
- **An optional friendly name** you may set for the link.

## What the skill does NOT process

- **No Loxone Miniserver credentials.** Your Miniserver username/password
  stay on your LoxBerry and are never transmitted to the cloud backend.
- **No voice recordings or transcripts** (Alexa sends only structured
  commands, never audio).
- **No advertising, analytics, tracking, profiling, or sale of any data.**
- **No Amazon profile data** (name, email, address) is requested or stored.

## How data flows and where it is stored

Commands and device state pass between Alexa, an AWS Lambda backend operated
by Martin Korndörfer, and your LoxBerry. A relay ("bridge") forwards these
messages but only ever sees **end-to-end authenticated, opaque payloads** — it
cannot read your device data.

Account-linking records are stored in **AWS DynamoDB in the EU (Ireland,
`eu-west-1`)**, encrypted at rest. Short-lived authorization codes expire
automatically within minutes.

Data is shared only with **Amazon** (as required to operate the Alexa skill).
It is shared with no other third parties. The backend is open source and may
be self-hosted, in which case the self-hoster is the controller.

## Retention and deletion

Linking data is retained only while the skill is linked. To revoke and delete
it: disable/unlink the skill in the Alexa app, or use **"kill all pairings"**
in the plugin's web interface. You may also request deletion via the contact
above.

## Your rights

If you are in the EU/EEA, you have the right to access, rectification,
erasure, restriction, objection, and data portability regarding your personal
data, and the right to lodge a complaint with your data-protection supervisory
authority. To exercise these rights, contact martin@korndoerfer.de.

## Children

This skill is not directed at children.

## Changes

Updates to this policy are published in the project's public repository with a
revised effective date.
