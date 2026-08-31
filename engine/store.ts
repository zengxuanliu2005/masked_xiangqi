import type { GameMode, Color, MatchType } from "../shared/contracts";
import { createGame } from "./setup";
import type { GameState } from "./types";

export class GameStoreCapacityError extends Error {
  readonly code = "CAPACITY_EXCEEDED";

  constructor() {
    super("对局容量已满，请结束或稍后重试。");
    this.name = "GameStoreCapacityError";
  }
}

export interface GameStoreOptions {
  maxGames?: number;
  finishedRetentionMs?: number;
  activeIdleMs?: number;
  now?: () => Date;
}

export class GameStore {
  private readonly games = new Map<string, GameState>();
  private readonly maxGames: number;
  private readonly finishedRetentionMs: number;
  private readonly activeIdleMs: number;
  private readonly now: () => Date;

  constructor(options: GameStoreOptions = {}) {
    this.maxGames = options.maxGames ?? 512;
    this.finishedRetentionMs = options.finishedRetentionMs ?? 60 * 60 * 1_000;
    this.activeIdleMs = options.activeIdleMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());
  }

  private pruneExpired(): void {
    const now = this.now().getTime();
    const finished: string[] = [];
    const idle: string[] = [];
    for (const [id, game] of this.games) {
      if (
        game.status.phase === "finished" &&
        game.finishedAt &&
        now - new Date(game.finishedAt).getTime() > this.finishedRetentionMs
      ) {
        finished.push(id);
      } else if (
        game.status.phase === "active" &&
        now - new Date(game.lastAccessedAt).getTime() > this.activeIdleMs
      ) {
        idle.push(id);
      }
    }
    for (const id of [...finished, ...idle]) this.games.delete(id);
  }

  create(options: {
    mode: GameMode;
    player1Side: Color;
    matchType: MatchType;
    aiModel?: string | null;
    seed?: string;
    allowDraw?: boolean;
    allowUndo?: boolean;
  }): GameState {
    this.pruneExpired();
    if (this.games.size >= this.maxGames) throw new GameStoreCapacityError();
    const game = createGame(options);
    const timestamp = this.now().toISOString();
    game.createdAt = timestamp;
    game.updatedAt = timestamp;
    game.lastAccessedAt = timestamp;
    this.games.set(game.id, game);
    return game;
  }

  get(id: string): GameState | undefined {
    const game = this.games.get(id);
    if (game) game.lastAccessedAt = this.now().toISOString();
    return game;
  }

  get size(): number {
    return this.games.size;
  }

  clear(): void {
    this.games.clear();
  }
}
