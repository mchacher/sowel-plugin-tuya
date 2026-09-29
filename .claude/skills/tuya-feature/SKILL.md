---
name: tuya-feature
description: |
  Implements a feature or a new product profile in sowel-plugin-tuya. Use when:
  - User asks to "implement", "create a feature", "support a new Tuya device"
  - User says "implémenter", "créer une feature", "supporter un nouvel appareil Tuya"
  Same workflow as the Sowel core (sowel-feature): spec with gates, branch, tests, agent review, PR, explicit merge approval.
disable-model-invocation: true
argument-hint: "[description de la feature ou du produit à supporter]"
---

# sowel-plugin-tuya — feature workflow

Feature request: $ARGUMENTS

Follow EVERY phase IN ORDER. Each phase has a GATE. Do NOT skip gates. Do NOT combine phases.

Conventions live in `CLAUDE.md`. Read its non-negotiable rules before designing anything; they are not reopened by a spec without saying so.

---

## Phase 1: Understand & Clarify

1.1 Read `CLAUDE.md`, `docs/specs-index.md` and `specs/` (there may already be a spec for this).
1.2 Ask clarifying questions until a complete spec can be written without assumptions: what, why, scope in/out, data, API surface used, edge cases.
1.3 Search the codebase for similar patterns before inventing.
1.4 **For a new product profile**, establish the DP map from evidence, never from a guess:

- a raw DP dump from the real device (idle, plugged, working), or a published reverse-engineering source named in the spec with its commit;
- for each DP: id, type, scale, unit, enum values, read-only or writable, and which dump shows it;
- DPs whose meaning is not established are listed as **not published**, with the reason.

1.5 If the feature needs something the core does not offer (an equipment type, a category, an API method), write it down as a **core issue** to open, with its own product argument. Do not work around it here.

> **GATE 1**: requirements clear, existing patterns checked, DP evidence in hand for a profile, core dependencies identified.

## Phase 2: Document the spec

```bash
ls specs/ | tail -1          # next number
mkdir specs/NNN-<kebab-name>
```

Write three files, in English (CI fails a new spec folder missing one):

| File              | Content                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `spec.md`         | Context, goals, non-goals, functional requirements, acceptance criteria, edge cases                 |
| `architecture.md` | DP map (for a profile), data and order flows, contracts with Sowel's API, file changes              |
| `plan.md`         | Implementation steps and the **test plan** (module, scenario, expected), including fixture payloads |

Then **a row in `docs/specs-index.md`** for the new folder, in the same commit. `npm run validate` fails without it.

Present a summary to the user and ask: "Voulez-vous que j'implémente ?"

> **GATE 2**: three files written, test plan included, index row added, user said "oui" / "go".

## Phase 3: Branch & implement

```bash
git checkout main && git pull
git checkout -b feat/<name>      # feat/ fix/ refactor/ docs/
```

Implementation order:

1. Types and pure modules first (DP decoding, scaling, enum mapping), testable without a socket
2. Profile data and its fixtures (recorded payloads, secrets scrubbed)
3. Transport behind an interface, so the plugin is tested against a fake device
4. Devices declared through discovery, readings through `updateDeviceData`
5. Orders, with read-back verification
6. Tests
7. `manifest.json` (settings, version), README (supported products table)

Tests are mandatory: every scenario of the plan's test plan gets a test, next to its module, Vitest. No test opens a real socket.

> **GATE 3**: on a feature branch, order followed, every planned scenario has a test.

## Phase 4: Validate

```bash
npm run validate     # typecheck, typecheck:tests, lint, format:check, test, build, specs index
```

Zero errors. This is exactly what CI runs.

When the change touches the transport or a profile and the hardware is reachable, also run it against the real device and paste the outcome (redacted) in the PR. Say plainly when that was not possible.

> **GATE 4**: validate is green; hardware check done or explicitly not done.

## Phase 5: Agent review

Spawn a review agent on `git diff main...HEAD` with the spec as intent. Checklist: correctness and edge cases, conventions in `CLAUDE.md` (local only, secrets never logged, never throw, verified writes), scope (nothing beyond the spec), tests match the plan, no secret in fixtures, no weakened gate. Fix blocking findings, re-run Phase 4, summarise the outcome.

> **GATE 5**: no unresolved blocking finding.

## Phase 6: Commit & PR

Conventional commits, scopes: transport, profiles, ev-charger, devices, orders, discovery, manifest, ci. Tick acceptance criteria in `spec.md` and tasks in `plan.md`. No `Co-Authored-By: Claude` line.

```bash
git push -u origin feat/<name>
gh pr create --title "feat(scope): ..." --body "Summary / Changes / Test plan"
```

> **GATE 6**: PR URL shared with the user.

## Phase 7: Wait for merge approval

**Never merge without an explicit "oui" / "merge" / "go".** Then:

```bash
gh pr merge <n> --squash --delete-branch && git checkout main && git pull
```

Then close the loop on the record, before saying you are done: tick the spec's status to ✅ in `docs/specs-index.md` (one-line PR), and open the core issues identified in Phase 1.5 if they are not open yet.
