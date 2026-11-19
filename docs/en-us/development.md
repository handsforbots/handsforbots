# Development

Requirements: Node 20+ and pnpm 10.

```bash
pnpm install
pnpm test        # Vitest for all packages + node:test for semantic-event-observability
pnpm typecheck
pnpm test:browser  # *.browser.test.ts in headless Chromium (first time: pnpm exec playwright install chromium)
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
- **XSS.** `packages/widget/test/xss.browser.test.ts` renders the same payloads in Chromium with `alert` replaced by a counter, so a payload that ever runs fails (a raw-HTML control proves the counter works), and `packages/mcp-apps/test/csp.browser.test.ts` mounts MCP Apps of many HTML shapes and checks that their script can neither reach the network nor the host page. CI runs them in the `browser` job. `packages/widget/test/xss.test.ts` feeds known payloads and random Markdown/HTML mixes ([fast-check](https://fast-check.dev)) to every widget surface and fails if the DOM gets a tag, event handler or URL scheme the widget does not make. Add a case there when you add a surface that turns content into HTML or URLs. CodeQL (`security-extended`) scans `packages/` on every push and pull request; findings show under Security → Code scanning.
- **Microphone.** The browser config starts Chromium with a fake capture device, no permission prompt and audio without a user gesture. `packages/voice/test/noise.browser.test.ts` runs the noise check on synthetic Web Audio streams and on the fake microphone, and checks that `detectEndOfSpeech` ends speech over steady noise above its fixed threshold.
- **Workflows.** GitHub Actions and container images are pinned by commit SHA or digest; Dependabot updates them.

## Releasing

Packages are published by `.github/workflows/release.yml` with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves to npm which repository and workflow is publishing (OIDC), so no npm token is stored and no 2FA prompt is needed. npm adds a provenance attestation to every version.

To release:

1. Bump every `2.0.0-*` package and the pin in `docs/*/packages.md` to the new version, commit (`chore: release <version> ...`) and push to `main`.
2. Tag the commit with the same version and push the tag:

```bash
git tag v2.0.0-alpha.3
git push origin v2.0.0-alpha.3
```

The workflow checks that the tag matches `packages/core`'s version, runs the tests, typecheck and build, and publishes each public package whose version is not on npm yet, with the `alpha` tag, then points `latest` at it as well. Run it by hand (Actions → Release → Run workflow) to retry a failed release (published versions are skipped), to publish without moving `latest`, or as a dry run. `node scripts/publish.mjs --dry-run` shows locally what would be published.

One-time setup, per package, on npm (packages that already exist only):

- **Trusted publisher:** run `scripts/npm-trust.sh` logged in to npm (`npm login`). The first request asks for 2FA; tick "skip for 5 minutes" so the rest go through. Do it right before a release: a trusted publisher that has not published within 2 days expires and has to be created again. A new package is published by hand once (`npm publish` from its folder after `pnpm build`), then added to the trust setup.
- **Moving `latest`:** enable "Allow npm dist-tag" in each package's settings on npmjs.com. Without it the versions are still published with `alpha`, and the workflow warns which `latest` tags it could not move.
- Optional, once the workflow has published: under Settings → Publishing access, "Require two-factor authentication and disallow tokens", so only the workflow (and you, with 2FA) can publish.
