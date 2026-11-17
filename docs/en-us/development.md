# Development

Requirements: Node 20+ and pnpm 10.

```bash
pnpm install
pnpm test        # Vitest for all packages + node:test for semantic-event-observability
pnpm typecheck
pnpm build       # emits dist/ for every package (exports switch to dist/ on publish)
```

Layout:

```
packages/<name>/src     TypeScript sources (exports point here inside the workspace)
packages/<name>/test    Vitest (jsdom where the DOM is needed)
test/                   Repository checks (third-party notices)
examples/react-agui     React + AG-UI + voice + WebMCP, with a mock agent (pnpm)
examples/vite           Rasa + widget + guided tours + observability (Docker or npm)
```

Run the examples:

```bash
pnpm --filter @handsforbots/example-react-agui dev
cd examples && docker compose up            # Rasa example (see examples/README.md)
```

Conventions:

- One package per capability; plugins never import each other at runtime (types only), they discover services through `ctx.get()`.
- Every behavior gets a test; timing-dependent tests wait for conditions, not fixed delays.
- A new third-party package (any `package.json`, or a module the host loads for us) goes into [`NOTICE.md`](../../NOTICE.md) and [`docs/pt-br/NOTICE.md`](../pt-br/NOTICE.md) with its use and license; `pnpm test` fails otherwise. Copied code goes there too.
- Libraries, services, specs and papers behind a decision go into [References](./references.md) (both languages), in the section of their topic.
- Architecture decisions and status live in [ROADMAP.md](../../ROADMAP.md).

Security checks:

- **Secrets.** `pnpm install` points `core.hooksPath` at `.githooks/`, whose `pre-commit` runs [Gitleaks](https://github.com/gitleaks/gitleaks) on the staged changes and blocks the commit if it finds a key, token or private key. It needs `gitleaks` installed (`brew install gitleaks`) or Docker running. CI scans the whole history again. A false positive goes into `.gitleaksignore` (its fingerprint and the reason); a real secret must be revoked, not just removed from the commit.
- **Dependencies.** CI fails when `pnpm audit --prod` finds a moderate or worse advisory in what the packages ship; advisories in dev tooling and examples are reported as warnings. When the parent package has no patched release yet, raise the floor with an `overrides` entry in `pnpm-workspace.yaml` (with the advisory id) and remove it once the parent catches up. Dependabot opens weekly update PRs, waiting 7 days after each release.
- **Workflows.** GitHub Actions and container images are pinned by commit SHA or digest; Dependabot updates them.
