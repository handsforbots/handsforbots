# Desenvolvimento

Requisitos: Node 20+ e pnpm 10.

```bash
pnpm install
pnpm test        # Vitest em todos os pacotes + node:test na semantic-event-observability
pnpm typecheck
pnpm test:browser  # *.browser.test.ts no Chromium headless (na primeira vez: pnpm exec playwright install chromium)
pnpm build       # gera dist/ em cada pacote (os exports passam para dist/ na publicação)
```

Estrutura:

```
packages/<nome>/src     fontes TypeScript (os exports apontam para cá dentro do workspace)
packages/<nome>/test    Vitest (jsdom quando precisa de DOM)
test/                   verificações do repositório (créditos de terceiros)
examples/react-agui     React + AG-UI + voz + WebMCP, com agente simulado (pnpm)
examples/vite           Rasa + widget + tours guiados + observabilidade (Docker ou npm)
```

Rodando os exemplos:

```bash
pnpm --filter @handsforbots/example-react-agui dev
cd examples && docker compose up            # exemplo Rasa (veja examples/README.md)
```

Convenções:

- Um pacote por capacidade; plugins não importam uns aos outros em runtime (só tipos), descobrem serviços via `ctx.get()`.
- Todo comportamento tem teste; testes que dependem de tempo esperam condições, não atrasos fixos.
- Pacote de terceiros novo (qualquer `package.json`, ou módulo que o hospedeiro carrega para nós) entra no [`NOTICE.md`](./NOTICE.md) e no [`NOTICE.md` em inglês](../../NOTICE.md) com uso e licença; senão o `pnpm test` falha. Código copiado também.
- Bibliotecas, serviços, especificações e artigos por trás de uma decisão entram nas [Referências](./references.md) (nos dois idiomas), na seção do tema.
- Decisões de arquitetura e estado do projeto ficam no [ROADMAP.md](../../ROADMAP.md).

Verificações de segurança:

- **Segredos.** O `pnpm install` aponta o `core.hooksPath` para `.githooks/`, cujo `pre-commit` roda o [Gitleaks](https://github.com/gitleaks/gitleaks) nas mudanças preparadas e bloqueia o commit se achar chave, token ou chave privada. Precisa do `gitleaks` instalado (`brew install gitleaks`) ou do Docker rodando. O CI varre o histórico inteiro de novo. Falso positivo vai para o `.gitleaksignore` (a impressão digital e o motivo); segredo real precisa ser revogado, não só tirado do commit.
- **Dependências.** O CI falha quando o `pnpm audit --prod` acha um alerta moderado ou pior no que os pacotes entregam; alertas em ferramentas de desenvolvimento e exemplos aparecem como aviso. Quando o pacote pai ainda não tem versão corrigida, suba o piso com uma entrada em `overrides` no `pnpm-workspace.yaml` (com o id do alerta) e remova quando o pai alcançar. O Dependabot abre PRs de atualização toda semana, esperando 7 dias depois de cada versão.
- **XSS.** O `packages/widget/test/xss.browser.test.ts` renderiza os mesmos payloads no Chromium com o `alert` trocado por um contador, então um payload que chegue a rodar faz o teste falhar (um controle com HTML cru prova que o contador funciona), e o `packages/mcp-apps/test/csp.browser.test.ts` monta MCP Apps em vários formatos de HTML e confere que o script deles não alcança a rede nem a página. O CI roda esses testes no job `browser`. O `packages/widget/test/xss.test.ts` passa payloads conhecidos e misturas aleatórias de Markdown e HTML ([fast-check](https://fast-check.dev)) por toda superfície do widget e falha se o DOM ganhar uma tag, um handler de evento ou um esquema de URL que o widget não gera. Acrescente um caso lá ao criar uma superfície que transforma conteúdo em HTML ou URL. O CodeQL (`security-extended`) varre `packages/` a cada push e pull request; os achados aparecem em Security → Code scanning.
- **Microfone.** A configuração de navegador abre o Chromium com um dispositivo de captura falso, sem pedido de permissão e com áudio sem gesto do usuário. O `packages/voice/test/noise.browser.test.ts` roda o teste de ruído em streams sintéticos do Web Audio e no microfone falso, e confere que o `detectEndOfSpeech` encerra a fala sobre um ruído constante acima do limite fixo.
- **Workflows.** Actions do GitHub e imagens de contêiner ficam fixadas por SHA do commit ou digest; o Dependabot as atualiza.

## Publicando

Os pacotes são publicados pelo `.github/workflows/release.yml` com [trusted publishing do npm](https://docs.npmjs.com/trusted-publishers): o GitHub Actions prova ao npm qual repositório e qual workflow estão publicando (OIDC), então nenhum token do npm fica guardado e não há pedido de 2FA. O npm anexa um atestado de proveniência a cada versão.

Para publicar:

1. Suba a versão de todos os pacotes `2.0.0-*` e a versão fixada em `docs/*/packages.md`, faça o commit (`chore: release <versão> ...`) e o push para a `main`.
2. Crie a tag com a mesma versão no commit e envie a tag:

```bash
git tag v2.0.0-alpha.3
git push origin v2.0.0-alpha.3
```

O workflow confere se a tag bate com a versão do `packages/core`, roda os testes, o typecheck e o build, e publica cada pacote público cuja versão ainda não está no npm, com a tag `alpha`, e depois aponta o `latest` para ela também. Rode-o à mão (Actions → Release → Run workflow) para repetir um release que falhou (versões já publicadas são puladas), para publicar sem mover o `latest`, ou como simulação. `node scripts/publish.mjs --dry-run` mostra localmente o que seria publicado.

Configuração única, por pacote, no npm (só para pacotes que já existem):

- **Trusted publisher:** rode o `scripts/npm-trust.sh` logado no npm (`npm login`). O primeiro pedido exige 2FA; marque "pular por 5 minutos" para os outros passarem. Faça isso logo antes de um release: um trusted publisher que não publica em 2 dias expira e precisa ser criado de novo. Um pacote novo é publicado à mão uma vez (`npm publish` na pasta dele, depois do `pnpm build`) e então entra na configuração.
- **Mover o `latest`:** ative "Allow npm dist-tag" nas configurações de cada pacote no npmjs.com. Sem isso as versões saem com `alpha` mesmo assim, e o workflow avisa quais tags `latest` não conseguiu mover.
- Opcional, depois que o workflow já tiver publicado: em Settings → Publishing access, "Require two-factor authentication and disallow tokens", para que só o workflow (e você, com 2FA) possa publicar.
