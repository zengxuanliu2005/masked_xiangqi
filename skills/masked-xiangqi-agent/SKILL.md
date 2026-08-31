---
name: masked-xiangqi-agent
description: Control or troubleshoot a local 覆子 (masked Xiangqi) game through its public, revisioned REST API, including launching the repository-owned Ollama Agent Runner. Use for Agent play, move submission, controller recovery, or integrations with this repository; never use internal game state to choose moves.
---

# Masked Xiangqi Agent

Control a game only through the API at `http://127.0.0.1:3001/api/v1`. The public game projection and `legal-moves` response are the complete information boundary.

## Invariants

- Never inspect `engine/store.ts`, process memory, a Seed-derived arrangement, or other server internals to identify covered pieces.
- A covered board piece has `publicIdentity` and `controller`, but no `identity`. Do not infer or claim its true identity.
- While a game is active, public `seed` is always `null`. It is disclosed only after `status.phase` becomes `finished`; never seek it from local files or server internals.
- Select only an entry returned by the current `legal-moves` response. Submit its `from` and `to` with that response's `revision`.
- On `STALE_REVISION`, discard the choice and restart from `GET /games/:id`. Never replay a decision made for an older revision.
- Stop choosing moves after `status.phase` becomes `finished`.

## Use the built-in Ollama Runner

For `human-ai`, create the game first and then call:

```bash
curl -X POST http://127.0.0.1:3001/api/v1/games/GAME_ID/agent-session
```

The server writes a private session file and launches the fixed repository Runner. If automatic terminal launch fails, use the exact `manualCommand` shown by the web UI. This command contains the local session-file path by design, but never the session token. The underlying entrypoint is always:

```bash
MASKED_XIANGQI_AGENT_SESSION_FILE=/absolute/path/to/session.json npm run agent:run
```

PowerShell uses `$env:MASKED_XIANGQI_AGENT_SESSION_FILE='C:\path\session.json'; npm run agent:run`. Prefer the server-provided command because it uses the correct platform quoting and current private session file.

Do not construct a second Ollama prompt, chess-rule engine, or fallback move selector. The formal Runner owns streaming thinking, one correction retry, revision cancellation, status reporting, and JSONL logging.

Use the session endpoints to read status, restart a paused/exited controller, or stop it. Built-in human-versus-model games always assign the Runner to `players.player2`.

## Control a side with another Agent

For an explicitly designated side, repeat this loop:

1. Read the public game and stop if it is finished or the designated side is not `turn`.
2. Read all legal moves and verify its `revision` and `turn` match the game.
3. Choose one returned move without seeking hidden information.
4. Submit it with `expectedRevision`.
5. On a version conflict, discard the choice and return to step 1.

Read [references/api.md](references/api.md) for endpoint bodies, coordinate conventions, errors, controller states, and terminal recovery.
