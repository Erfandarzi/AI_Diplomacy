# Human-vs-LLM Local Play

This adds a local browser controller around the existing `diplomacy.Game` engine and `ai_diplomacy` agent stack.

## Quick Start

Run with real OpenRouter agents:

```bash
OPENROUTER_API_KEY=your_key_here .venv/bin/python human_play.py
```

Open:

```text
http://127.0.0.1:8765
```

The default model is `openrouter:deepseek/deepseek-v4-flash`, with short chat outputs and compact order-generation caps for fast local play.

Run with another OpenRouter model:

```bash
OPENROUTER_API_KEY=your_key_here .venv/bin/python human_play.py --models openrouter:deepseek/deepseek-chat
```

Run with deterministic local mock agents only for smoke tests:

```bash
.venv/bin/python human_play.py --mock-agents
```

You can also pass one model per non-human power:

```bash
.venv/bin/python human_play.py \
  --human-power FRANCE \
  --models "openrouter:deepseek/deepseek-v4-flash,openrouter:deepseek/deepseek-v4-flash,openrouter:deepseek/deepseek-v4-flash,openrouter:deepseek/deepseek-v4-flash,openrouter:deepseek/deepseek-v4-flash,openrouter:deepseek/deepseek-v4-flash"
```

For local OpenAI-compatible servers:

```bash
.venv/bin/python human_play.py \
  --models "openai:local-model@http://localhost:8000/v1#local-api-key"
```

## What Works

- Standard Diplomacy rules and adjudication through the vendored `diplomacy` engine.
- You control one power in the browser.
- Other powers are `DiplomacyAgent` instances using the existing prompt, memory, relationship, and order-generation code.
- Public/private press visible to the human player.
- Legal order selection from the engine's possible orders.
- Manual phase resolution.
- Saved game output in `results/human_*`, including `lmvsgame.json` and LLM logs.

## Notes

- If no `OPENROUTER_API_KEY` or other provider key is present, pass `--mock-agents` explicitly for development smoke tests.
- The original batch simulator in `lm_game.py` is unchanged.
- This is local single-human play, not LAN or internet multiplayer.
