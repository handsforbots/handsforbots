# Hands for Bots — Agent Skills

Skills that teach coding agents (Claude Code and other tools that read the [Agent Skills](https://agentskills.io) format) how to integrate Hands for Bots v2 correctly: which packages to install and what they need, how to wire them, and the details that are easy to miss. They describe the library's verified behavior.

| Skill | Use it for |
|---|---|
| [`handsforbots`](./handsforbots/SKILL.md) | Kernel setup, actions, context signals, widget/React/Vue, menu, guided tours, keyboard, page inputs, plugins. References: [`packages.md`](./handsforbots/references/packages.md) (every package: imports, peers, what it needs, what it is for) and [`runtime.md`](./handsforbots/references/runtime.md) |
| [`handsforbots-integrations`](./handsforbots-integrations/SKILL.md) | Choosing and wiring a transport and the backend on the other side (AG-UI, HTTP, OpenAI-compatible, Vercel AI SDK, Rasa), CopilotKit, assistant-ui, WebMCP browser agents, MCP Apps |
| [`handsforbots-history`](./handsforbots-history/SKILL.md) | Reading the history, recording GUI decisions with `runAction`, decision timelines. Ships [`timeline.ts`](./handsforbots-history/scripts/timeline.ts) |
| [`handsforbots-persistence`](./handsforbots-persistence/SKILL.md) | Memory (turns sent, kept, compacted), explicit conversation state, browser or server storage, encryption with an expiring key, retention choices, tab modes, and the server endpoints |
| [`handsforbots-conversation`](./handsforbots-conversation/SKILL.md) | Messages sent while the assistant answers (interrupt, merge, queue), stop buttons, continuous voice conversation: open microphone, end-of-turn models, barge-in, state for voice UIs |
| [`handsforbots-speech`](./handsforbots-speech/SKILL.md) | The bot's voice: browser, backend or models in the page (Piper, Kokoro, transformers.js), when models download and who speaks meanwhile, effects as JSON, presets, SSML and FFmpeg export |
| [`handsforbots-consent`](./handsforbots-consent/SKILL.md) | Working with a consent tool: purposes, rule sets per legislation and region (JSON/YAML), erasing storage on revoke, anonymization for human review |

## Install in your project

**Claude Code**, as a plugin from this repository's marketplace (it follows the repository: `/plugin marketplace update handsforbots` brings the latest skills):

```
/plugin marketplace add handsforbots/handsforbots
/plugin install handsforbots@handsforbots
```

The skills then show up as `handsforbots:handsforbots`, `handsforbots:handsforbots-integrations` and so on, and load when your task involves Hands for Bots.

**Any agent that reads skill folders**: copy the folders into your project's `.claude/skills/` (or `~/.claude/skills/` for every project, or the folder your tool reads):

```bash
git clone --depth 1 https://github.com/handsforbots/handsforbots /tmp/h4b
mkdir -p .claude/skills
cp -r /tmp/h4b/skills/handsforbots* .claude/skills/
```

Skills for working on the library itself live in [`.claude/skills/`](../.claude/skills/) and load automatically in this repository.

## Instalar no seu projeto (pt-BR)

Skills que ensinam agentes de código a integrar o Hands for Bots v2 corretamente: quais pacotes instalar e do que precisam, como ligá-los e os detalhes fáceis de errar.

**Claude Code**, como plugin do marketplace deste repositório (acompanha o repositório: `/plugin marketplace update handsforbots` traz as skills mais recentes):

```
/plugin marketplace add handsforbots/handsforbots
/plugin install handsforbots@handsforbots
```

**Qualquer agente que leia pastas de skills**: copie as pastas para `.claude/skills/` do seu projeto (ou `~/.claude/skills/` para todos os projetos, ou a pasta que a sua ferramenta lê):

```bash
git clone --depth 1 https://github.com/handsforbots/handsforbots /tmp/h4b
mkdir -p .claude/skills
cp -r /tmp/h4b/skills/handsforbots* .claude/skills/
```

As skills para quem mantém a biblioteca ficam em [`.claude/skills/`](../.claude/skills/) e carregam sozinhas neste repositório.
