# `modules/` — the domain

One folder per bounded capability. A module owns its data access, its rules, and its
external integrations, and exposes a narrow interface to everything else.

## The layering rule

```
http/  ──▶  modules/  ──▶  platform/
```

`http/` may import `modules/`. **`modules/` must never import `http/`.** Anything in a
module that needs a `Request` or a `Response` has business logic in the wrong layer, and
the practical cost is that it cannot be tested without spinning up Express. ESLint
enforces the direction; it is not on the honour system.

Modules may import `platform/`. Modules should import each other sparingly and only
through the neighbour's `index.ts` — never by reaching into its internals.

## Why the prototype needed this

`social.routes.ts` was 845 lines containing the X OAuth handshake, HTTP parameter
parsing, Prisma queries, and posting logic interleaved. None of it could be exercised
without an HTTP request and a live X app. Splitting by capability is what makes each part
testable on its own.

## Modules

| Module | Owns | Workstream |
|--------|------|------------|
| `identity/` | Users, workspaces, memberships, sign-in | W0 seam, W3 |
| `brand/` | Brand profiles, voice, palette, assets | W3 |
| `template/` | Post templates and their slots | W4 |
| `render/` | Satori → resvg → PNG rendering | W4 |
| `publish/` | `PlatformAdapter` per network, credential resolution | W6 |
| `trend/` | `TrendCollector` implementations, trend storage | W7 |
| `insight/` | Metric collection and aggregation | W8 |
| `recommend/` | Turning trends and insights into suggestions | W9 |
| `ai/` | Provider-agnostic text and structured generation | W0 |

Each folder has a `README.md` stating its responsibility, its boundaries, and the
workstream that builds it out. Folders with a README and no code are scaffolding, and
that is intentional — the shape is agreed in M1 so later workstreams do not each invent
their own.
