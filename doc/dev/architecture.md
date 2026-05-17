# Architecture

[← Dev index](README.md)

## Why it looks like this

A naïve Alexa Smart Home integration would expose an HTTPS endpoint on the
user's network for Amazon to call. That requires a public IP / DynDNS, an open
port, and a valid TLS certificate per user — and it puts the home automation
box directly on the internet. Aloxberry rejects that. Instead:

- The plugin **dials out** and holds a persistent WebSocket to a **bridge**.
- A shared **AWS backend** is what Amazon's skill actually talks to (Smart Home
  skills require a Lambda endpoint anyway).
- The backend hands directives to the bridge, which relays them down the
  already‑open socket to the right plugin.
- **End‑to‑end HMAC** between Lambda and plugin means the bridge — the only
  multi‑tenant, publicly reachable hop — is a *blind relay*.

The result: many independent LoxBerry installs share one free backend, nobody
opens a port, and no intermediary can read or forge a user's commands.

## The four parts

| Part | Process / location | Responsibility |
|------|--------------------|----------------|
| Plugin **daemon** | Node.js, on the LoxBerry | Loxone comms, directive execution, identity, bridge socket, local API |
| Plugin **CGI** | Perl, on the LoxBerry | Config UI: device picker, pairing, status, settings |
| **Bridge** | Node.js, project‑hosted or self‑hosted | Stateless routing of signed directives ↔ plugins |
| **AWS backend** | Lambda + DynamoDB + SSM | Account linking (OAuth), directive dispatch, fan‑out of state events |

## Directive flow (e.g. "Alexa, turn on the kitchen light")

```mermaid
sequenceDiagram
    participant U as User
    participant AX as Alexa
    participant L as alexa-handler (Lambda)
    participant D as DynamoDB
    participant B as Bridge
    participant P as Plugin daemon
    participant M as Miniserver

    U->>AX: "turn on kitchen light"
    AX->>L: Smart Home directive (+ bearer token)
    L->>L: verify JWT → userId
    L->>D: lookup userId → skillSecret
    L->>L: HMAC-sign directive (skillSecret)
    L->>B: POST /dispatch (signed)
    B->>P: WSS "directive" frame (opaque to B)
    P->>P: verify HMAC, route by namespace
    P->>M: jdev/sps/io/<uuid>/On
    M-->>P: ack
    P-->>B: WSS "response" frame
    B-->>L: 200 (Alexa response envelope)
    L-->>AX: response
    AX-->>U: "OK"
```

Key point: the bridge in the middle never parses `directive` or `response`. It
matches `userId` → socket and forwards bytes. The HMAC is verified only at the
plugin, signed only at the Lambda.

## Account linking flow (pair‑code model)

Alexa Account Linking is OAuth2 Authorization Code Grant. Aloxberry layers a
**single‑use pair code** on top so the user never types Loxone or LoxBerry
credentials into an Amazon‑hosted form.

```mermaid
sequenceDiagram
    participant CGI as Plugin CGI
    participant P as Plugin daemon
    participant B as Bridge
    participant AX as Alexa app
    participant O as oauth-handler (Lambda)
    participant D as DynamoDB

    CGI->>P: POST /pair (local API)
    P->>P: generate 10-char code
    P->>B: publish code → {userId, skillSecret} (WSS, TTL 10 min)
    P-->>CGI: show code to user
    AX->>O: /authorize (user pastes pair code)
    O->>B: GET /pair?code=XXXX (X-Bridge-Auth)
    B-->>O: {userId, skillSecret}
    O->>D: store user row (userId, skillSecret)
    O-->>AX: redirect with auth code
    AX->>O: /token (exchange)
    O-->>AX: JWT access token (payload: userId) + refresh token
```

After linking, every directive carries the JWT; the Lambda decodes `userId`,
loads the matching `skillSecret`, and the directive flow above runs.

## Outbound state reports (proactive updates)

When a Loxone state the user exposed changes, Alexa should reflect it (and
Routines should be able to trigger). The plugin pushes a **ChangeReport**:

```mermaid
sequenceDiagram
    participant M as Miniserver
    participant P as Plugin daemon
    participant B as Bridge
    participant L as oauth-handler /event
    participant D as DynamoDB
    participant AX as Alexa Event Gateway

    M-->>P: WSS event (stateUuid, value)
    P->>P: reverse-index → device, map to Alexa property
    P->>P: sign canonical payload (skillSecret)
    P->>B: WSS "report" frame
    B->>L: POST /event (verbatim, signed)
    L->>D: find Alexa users for this bridgeUserId
    loop per linked Alexa account
        L->>AX: ChangeReport + that user's LWA token
    end
```

One daemon event fans out to N linked Alexa accounts; the Lambda owns the
per‑user LWA tokens, the daemon signs once.

## Trust boundaries

```mermaid
flowchart LR
    subgraph T1["Trusted: user's LAN"]
        P["Plugin daemon"]
        M["Miniserver"]
    end
    subgraph T2["Semi-trusted: Amazon + your Lambda"]
        AX["Alexa"]
        L["Lambda"]
    end
    subgraph T3["Untrusted hop: bridge"]
        B["Bridge"]
    end
    M ---|"Loxone creds stay here"| P
    P ---|"HMAC key shared only with L"| L
    L --- B
    B --- P
```

- **Loxone credentials**: never leave T1.
- **`skillSecret` (HMAC key)**: shared only between the plugin (T1) and the
  Lambda (T2). The bridge (T3) never has it.
- **The bridge**: assumed hostile in the threat model and still can't forge or
  read commands. Detail in [security-model.md](security-model.md).
