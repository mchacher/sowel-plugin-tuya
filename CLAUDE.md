# CLAUDE.md

Guidance for Claude Code (and any AI agent) working on `sowel-plugin-tuya`. First file to read. Same method as the Sowel core: spec with gates, feature branch, tests, agent review, PR, explicit merge approval.

## What this is

A Sowel **integration plugin** for **Tuya devices over the local network**. It opens the device's local socket (Tuya protocol 3.x, AES-encrypted with the device's `local_key`), reads its data points (DPs) and writes them, and publishes each device as an **ordinary Sowel device**: readings and orders, each with a `category`.

It is generic by construction and narrow by choice: a Tuya DP map is product-specific, so the plugin supports **one product profile at a time**, each specified and tested. The first profile is the **dé EV charger** (`depow_v2` layout, the two-button 3.5 kW portable model). Its purpose on the Sowel side is to charge an EV from solar surplus through the core's energy arbiter (core spec 140) — that logic lives in a recipe, never here.

## Where to find context

| You want to know...                         | Read this                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| How Sowel loads and isolates a plugin       | `mchacher/sowel`: `docs/technical/plugin-development.md`, `src/plugins/scoped-deps.ts` (spec 111)                                       |
| The API slice this plugin relies on         | `src/sowel-api.ts` (hand-synced with the core's `src/shared/plugin-api.ts`)                                                             |
| The energy arbiter the charger serves       | `mchacher/sowel`: `specs/140-energy-capacity-arbiter/` and `src/shared/types.ts` (`claimCapacity`)                                      |
| The dé charger's DP map, reverse-engineered | [lachand/EV_charger](https://github.com/lachand/EV_charger) — `custom_components/tuya_ev_charger/{const,tuya_ev_charger}.py`, issue #37 |
| Every feature specified here                | [docs/specs-index.md](docs/specs-index.md) — one row per spec, CI-gated                                                                 |
| Feature history in this repo                | `specs/NNN-name/{spec,architecture,plan}.md`                                                                                            |

The core repo is expected as a sibling directory (`../sowel`) for cross-reference and for the registry bump at release time.

## Non-negotiable rules

- **Local only at runtime.** No request to Tuya's cloud while the plugin runs. The cloud may only ever be used, if a spec decides so, to _obtain_ a `local_key` once, at the user's request.
- **This plugin publishes devices, never equipment types.** A device declares readings and orders with a `category`; the category is the contract. Whether a charger ends up on an `ev_charger` equipment is decided in the core, by a person binding it. A missing equipment type is a **core issue**, argued on its own merits, never worked around here.
- **A profile is data, pinned by recorded payloads.** Each supported product is a DP map (DP id → reading/order, type, scale, enum) and a set of test fixtures captured from the real device. A DP whose meaning is not established is not published. An unknown product is refused with a clear log line, never guessed.
- **One connection per device, owned by the plugin.** Tuya devices accept a single local client: reads and writes to one device are serialised, reconnection backs off, and the user is told plainly that the Smart Life app's local session or another integration will compete for it.
- **`local_key` is a secret.** A `password` setting, never logged (not even at debug, not even truncated), never in a fixture, a test or an issue. The gitleaks config carries a rule for it.
- **Never throw** from a handler or a timer. Log and degrade: the device goes `offline`, the plugin keeps running. `executeOrder` is the exception, because its caller needs the error: it rejects when the order is invalid, the device offline, or the value not reflected in time (spec 001 FR-16) — with a sanitised message, never the raw transport error.
- **Verify writes.** A Tuya device acknowledges a write before it applies it, and some DPs lag several seconds. An order is done when the DP reads back the value, within a bounded retry; otherwise it is logged as not reflected.
- **No automation.** The plugin never decides to start a charge, pick a current or react to the grid. That is a recipe's job, through the arbiter.
- **Spec 111 isolation**: this plugin can only write devices whose `integrationId === "tuya"`, read settings under `integration.tuya.*` plus `home.latitude/longitude/timezone`, and emit only `system.integration.*` / `system.alarm.*` events. Design within it.

## Tech

Node 24, TypeScript strict, ESM (`NodeNext`). Runtime dependencies are chosen in a spec and kept minimal (the Tuya transport is the expected one). Vitest. ESLint + Prettier as in the core. `console.*` is an error: use the injected pino logger, structured context first, message second.

```bash
npm install
npm run validate        # typecheck, typecheck:tests, lint, format:check, test, build, specs index — exactly what CI runs
npx vitest run <file>   # one test file
```

Local loop against a Sowel instance: build, then install through a personal source (core spec 136), or copy `manifest.json`, `package.json`, `dist/` and `node_modules/` into the instance's `plugins/tuya/`.

## Git workflow

- Feature branches for anything non-trivial: `feat/`, `fix/`, `refactor/`, `docs/`. Main is protected (PR required, linear history, CI green).
- Conventional commits. Scopes: `transport`, `profiles`, `ev-charger`, `devices`, `orders`, `discovery`, `manifest`, `ci`.
- **Never merge a PR without explicit user approval** ("oui", "merge", "go").
- **Never add `Co-Authored-By: Claude` lines** in commit messages or PR bodies.
- Every new `specs/NNN-name/` folder needs `spec.md`, `architecture.md`, `plan.md` **and a row in `docs/specs-index.md`** (two CI gates).
- A release is a PR (version bump in `package.json` **and** `manifest.json`, changelog entry) then a tag on main, then the **registry hash bump in the core** (spec 089). See the `tuya-release` skill.

## Skills

| Skill          | When                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| `tuya-feature` | Implementing a feature or a new product profile: spec, branch, tests, PR. |
| `tuya-release` | Bumping, tagging, publishing, and bumping the registry hash.              |

## Answering the user

Short and ordered. One or two lines for the what, one bullet per finding or decision. French or English, whichever the user uses.
