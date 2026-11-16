# Instructions for coding agents / Instruções para agentes de código

## v2 is the only active line. Do not work on v1.

- All development happens on **`main`**: the TypeScript monorepo in `packages/`.
- **v1 is discontinued** (the `handsforbots/` folder with `Bot.js`, `[•{...}•]` action tags and `bot.eventEmitter`, kept in the `v1-final` tag and older branches). Do not fix, extend, document or port anything to v1. If a request is about v1, say that v1 is discontinued and offer the v2 equivalent (`docs/en-us/migrating-from-v1.md`).
- There is no compatibility layer with v1 (ADR [0007](./docs/adr/0007-sem-compatibilidade-v1.md)).
- Branch new work from `main` and open pull requests against `main`. The old `v2` branch was merged into `main` and is no longer a target.

## A v2 é a única linha ativa. Não trabalhe na v1.

- Todo o desenvolvimento acontece na **`main`**: o monorepo TypeScript em `packages/`.
- **A v1 foi descontinuada** (a pasta `handsforbots/` com `Bot.js`, tags `[•{...}•]` e `bot.eventEmitter`, guardada na tag `v1-final` e em branches antigos). Não corrija, estenda, documente nem porte nada para a v1. Se um pedido for sobre a v1, diga que ela foi descontinuada e ofereça o equivalente na v2 (`docs/pt-br/migrating-from-v1.md`).
- Não há camada de compatibilidade com a v1 (ADR [0007](./docs/adr/0007-sem-compatibilidade-v1.md)).
- Crie branches a partir da `main` e abra pull requests contra a `main`. O antigo branch `v2` foi incorporado à `main` e não é mais alvo.

## Working on v2

- Requirements: Node 20+, pnpm 10. `pnpm install`, then `pnpm test` and `pnpm typecheck` before every commit (baseline: all green).
- Architecture and decisions: `ROADMAP.md`, `docs/adr/`. Conventions, layout and the contracts the docs rely on: `.claude/skills/handsforbots-maintainer/SKILL.md`.
- Public behavior changes update `docs/en-us` **and** `docs/pt-br` in the same commit, plus `skills/` when integrators are affected.
- Every behavior has a test; time-dependent tests wait for conditions, never fixed delays.
- Credit what we use, in the same commit: third-party packages and copied code in `NOTICE.md` + `docs/pt-br/NOTICE.md` (use and license; `test/third-party.test.ts` enforces the packages); specs, libraries, papers and borrowed designs behind a decision in `docs/en-us/references.md` + `docs/pt-br/references.md`, in the section of its topic.
- Commits: Conventional Commits in English, ending with a period (`feat(core): ...`, `docs: ...`).
