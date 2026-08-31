# Public API Reference

Base URL: `http://127.0.0.1:3001/api/v1`

## Coordinates and public pieces

Coordinates start at the board's upper-left. `x` is `0..8`; `y` is `0..9`. Red always moves first.

A covered piece is safe to expose only in this form:

```json
{
  "id": "piece-17",
  "position": { "x": 0, "y": 6 },
  "faceUp": false,
  "publicIdentity": { "color": "red", "type": "pawn" },
  "controller": "red"
}
```

`publicIdentity` governs its covered movement. It is not the hidden identity. Only revealed or captured pieces contain `identity`.

The top-level `seed` is `null` for every active game and becomes the normalized opening Seed only after the game finishes. A custom-Seed creator already knows their input, but an Agent must not inspect files or internals to recover the active Seed.

## Game loop

Read the game:

```http
GET /games/:id
```

Read legal moves for the current position:

```http
GET /games/:id/legal-moves
GET /games/:id/legal-moves?pieceId=piece-17
```

The response contains `gameId`, `revision`, `turn`, and `moves`. A move has `pieceId`, `from`, `to`, and `captures`.

Submit one returned move:

```http
POST /games/:id/moves
Content-Type: application/json

{
  "from": { "x": 0, "y": 6 },
  "to": { "x": 0, "y": 5 },
  "expectedRevision": 4
}
```

Successful moves return the new public game. The same rule engine validates browser, Runner, and external-Agent moves.

## Agent controller

The built-in controller endpoints are:

```http
POST   /games/:id/agent-session
GET    /games/:id/agent-session
POST   /games/:id/agent-session/restart
DELETE /games/:id/agent-session
```

Public controller states are `starting`, `waiting-human`, `thinking`, `submitting`, `paused`, `finished`, `stopped`, and `exited`. The public response includes terminal type, timestamps, local log location, and a readable error. It never includes the session token. A failed terminal launch may include `manualCommand`, and that command necessarily contains the local session-file path.

Runner-only status endpoints require the session-file bearer token. Do not place that token in URLs, shell arguments, prompts, logs, or browser state.

Only one active Runner is allowed per game. Repeating session creation returns the existing controller. Use `restart` only after `paused`, `exited`, `stopped`, or a `finished` controller whose game became active again after undo; stopping is observed by the Runner on its next poll.

## Errors

Errors use `{ "error": { "code", "message", "details"? } }`.

- `STALE_REVISION`: discard the unsubmitted decision, re-read game and legal moves.
- `GAME_FINISHED`: stop the loop.
- `NOT_AI_GAME`: built-in Agent sessions require `human-ai` plus `aiModel`.
- `NOT_AI_TURN`: wait; never submit for the other side.
- `NO_LEGAL_MOVES`: re-read the game status; do not invent a move.
- `ILLEGAL_MOVE`, `WRONG_SIDE`: discard the choice and re-read legal moves.
- `AGENT_SESSION_NOT_FOUND`: create a session before querying/restarting/stopping it.
- `AGENT_TOKEN_INVALID`: use the current private session file; an old token is invalid after restart.
- `OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_ERROR`, `OLLAMA_BAD_RESPONSE`: the built-in Runner retries once, then pauses without a random move.
- `MODEL_NOT_FOUND`, `MODEL_NOT_GENERATIVE`: re-read `/ai/models`; embedding-only models cannot play.
- `AI_DECISION_IN_PROGRESS`: another compatibility `/ai-move` call owns the per-game single flight; do not retry until it completes or the revision changes.
- `CAPACITY_EXCEEDED`: local game or controller capacity is full; do not spin-retry.

## Undo and termination

Undo increments `revision`; it never restores an old version number. Any in-flight decision for the previous revision must be aborted. In `human-ai`, undo returns to the human's prior turn target.

When the game finishes, stop model requests. The built-in terminal prints result, elapsed time, and `.local/agent-logs/<gameId>.jsonl`, then remains open until the player closes it.
