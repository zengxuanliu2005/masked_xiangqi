// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSessionState,
  AiModelsResponse,
  CreateGameRequest,
  LanViewerSeatState,
  PublicGameState,
} from "../shared/contracts";
import { App } from "../src/App";
import {
  ApiClientError,
  type GameApi,
  type NetworkStatusResponse,
} from "../src/api";
import {
  LAN_SEAT_TOMBSTONE_PREFIX,
  readSeatRecord,
  writeSeatRecord,
} from "../src/lan";

const initialGame: PublicGameState = {
  id: "game-ui",
  seed: null,
  mode: "standard",
  allowDraw: true,
  allowUndo: true,
  canUndo: false,
  matchType: "human-human",
  aiModel: null,
  revision: 0,
  turn: "red",
  moveNumber: 0,
  players: { player1: "red", player2: "black" },
  status: { phase: "active", winner: null, reason: null },
  check: null,
  board: [
    {
      id: "black-general",
      position: { x: 4, y: 0 },
      faceUp: true,
      publicIdentity: { color: "black", type: "general" },
      identity: { color: "black", type: "general" },
      controller: "black",
    },
    {
      id: "hidden-pawn",
      position: { x: 0, y: 6 },
      faceUp: false,
      publicIdentity: { color: "red", type: "pawn" },
      controller: "red",
    },
    {
      id: "red-general",
      position: { x: 4, y: 9 },
      faceUp: true,
      publicIdentity: { color: "red", type: "general" },
      identity: { color: "red", type: "general" },
      controller: "red",
    },
  ],
  captured: { red: [], black: [] },
  lastMove: null,
  createdAt: "2026-08-30T00:00:00.000Z",
};

const movedGame: PublicGameState = {
  ...initialGame,
  revision: 1,
  turn: "black",
  moveNumber: 1,
  canUndo: true,
  board: initialGame.board.map((piece) =>
    piece.id === "hidden-pawn"
      ? {
          ...piece,
          position: { x: 0, y: 5 },
          faceUp: true,
          identity: { color: "black" as const, type: "rook" as const },
          controller: "black" as const,
        }
      : piece,
  ),
  lastMove: {
    pieceId: "hidden-pawn",
    from: { x: 0, y: 6 },
    to: { x: 0, y: 5 },
    revealedIdentity: { color: "black", type: "rook" },
  },
};

const lanGame = ({
  guestClaimed = true,
  guestOnline = true,
  hostOnline = true,
  includeCode = true,
  undoRequest = null,
  viewer,
  ...rest
}: {
  guestClaimed?: boolean;
  guestOnline?: boolean;
  hostOnline?: boolean;
  includeCode?: boolean;
  undoRequest?: PublicGameState["lan"] extends infer T
    ? T extends { undoRequest: infer U }
      ? U
      : never
    : never;
  viewer?: LanViewerSeatState;
} & Partial<PublicGameState> = {}): PublicGameState => ({
  ...initialGame,
  matchType: "lan-human",
  ...rest,
  lan: {
    ...(includeCode ? { roomCode: "ABC234" } : {}),
    host: "red",
    seats: {
      red: { claimed: true, online: hostOnline },
      black: { claimed: guestClaimed, online: guestClaimed && guestOnline },
    },
    undoRequest,
    ...(viewer ? { viewer } : {}),
  },
});

const unavailableModels: AiModelsResponse = {
  provider: "ollama",
  available: false,
  models: [],
  message: "未检测到本机 Ollama 服务。",
};

function createMockApi(modelStatus: AiModelsResponse = unavailableModels) {
  let state = initialGame;
  let privateSeed = "MX-UI-TEST-01";
  let agentState: AgentSessionState = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    gameId: initialGame.id,
    status: "waiting-human",
    terminal: "terminal",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    lastActivityAt: "2026-08-30T00:00:00.000Z",
    error: null,
    logPath: ".local/agent-logs/game-ui.jsonl",
  };
  let networkState: NetworkStatusResponse = {
    mode: "loopback",
    targetMode: "loopback",
    port: 3001,
    addresses: [] as string[],
    error: null as string | null,
    pending: false,
    listening: true,
    local: true,
  };
  const createGame = vi.fn(async (request: CreateGameRequest) => {
    privateSeed = request.seed?.trim().normalize("NFC") ?? "MX-UI-TEST-01";
    state = {
      ...initialGame,
      mode: request.mode ?? "standard",
      allowDraw: request.allowDraw ?? true,
      allowUndo: request.allowUndo ?? true,
      canUndo: false,
      matchType: request.matchType,
      aiModel: request.aiModel ?? null,
      seed: null,
    };
    return state;
  });
  const getLegalMoves = vi.fn(async (id: string) => ({
    gameId: id,
    revision: state.revision,
    turn: state.turn,
    moves: [
      {
        pieceId: "hidden-pawn",
        from: { x: 0, y: 6 },
        to: { x: 0, y: 5 },
        captures: false,
      },
    ],
  }));
  const move = vi.fn(async () => {
    state = movedGame;
    return state;
  });
  const undo = vi.fn(async () => {
    state = {
      ...initialGame,
      allowUndo: state.allowUndo,
      revision: state.revision + 1,
      canUndo: false,
    };
    return state;
  });
  const resign = vi.fn(async () => {
    state = {
      ...state,
      seed: privateSeed,
      revision: state.revision + 1,
      status: {
        phase: "finished" as const,
        winner: state.turn === "red" ? ("black" as const) : ("red" as const),
        reason: "resignation" as const,
      },
    };
    return state;
  });
  const api: GameApi = {
    createGame,
    getAiModels: vi.fn(async () => modelStatus),
    getGame: vi.fn(async () => state),
    getLegalMoves,
    move,
    undo,
    resign,
    aiMove: vi.fn(async () => ({
      game: state,
      decision: {
        model: state.aiModel ?? "mock-model",
        source: "model" as const,
      },
    })),
    createAgentSession: vi.fn(async () => agentState),
    getAgentSession: vi.fn(async () => agentState),
    restartAgentSession: vi.fn(async () => {
      agentState = { ...agentState, status: "starting", error: null };
      return agentState;
    }),
    stopAgentSession: vi.fn(async () => {
      agentState = { ...agentState, status: "stopped", error: null };
      return agentState;
    }),
    createRoom: vi.fn(async () => {
      state = lanGame({ hostOnline: true, guestClaimed: false });
      return {
        game: state,
        roomCode: "ABC234",
        seat: { color: "red" as const, token: "host-token" },
      };
    }),
    joinRoom: vi.fn(async () => {
      // The guest is black and never receives the room code.
      state = lanGame({ guestClaimed: true, includeCode: false });
      return {
        game: state,
        seat: { color: "black" as const, token: "guest-token" },
      };
    }),
    reinvite: vi.fn(async () => ({ game: state, roomCode: "XYZ789" })),
    requestUndo: vi.fn(async () => state),
    resolveUndo: vi.fn(async () => state),
    getNetwork: vi.fn(async () => networkState),
    setNetworkMode: vi.fn(async (mode: "loopback" | "lan") => {
      const accepted = {
        ...networkState,
        targetMode: mode,
        pending: true,
      };
      networkState = {
        ...networkState,
        mode,
        targetMode: mode,
        addresses: mode === "lan" ? ["192.168.1.5"] : [],
        error: null,
        pending: false,
        listening: true,
      };
      return accepted;
    }),
  };
  return api;
}

async function openModeMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /开始游戏/ }));
  expect(
    await screen.findByRole("heading", { name: "这局，和谁下？" }),
  ).toBeInTheDocument();
}

async function startHumanGame(
  user: ReturnType<typeof userEvent.setup>,
  api: GameApi,
) {
  await openModeMenu(user);
  await user.click(screen.getByRole("button", { name: /选择双人对战/ }));
  expect(
    screen.getByRole("dialog", { name: "设置这一局" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /确认开局/ }));
  await waitFor(() => expect(api.createGame).toHaveBeenCalled());
  expect(
    await screen.findByRole("heading", { name: "标准模式" }),
  ).toBeInTheDocument();
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem?.("masked-xiangqi:last-game-id");
  Reflect.deleteProperty(window.navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function enableVisualMotion() {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 motion-test",
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
}

describe("游戏界面", () => {
  it("首页以新手教学替代抽象规则区，再进入独立的对战选择页", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);

    expect(
      screen.getByRole("heading", { name: /一步以前/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "三件事决定这盘棋" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新手教学" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "人人对战" }),
    ).not.toBeInTheDocument();

    await openModeMenu(user);
    expect(
      screen.getByRole("heading", { name: "人人对战" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "人机对战" }),
    ).toBeInTheDocument();
  });

  it("新手教学让玩家亲自选中暗子、走到落点并看到翻面换色", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);

    await user.click(screen.getByRole("button", { name: "新手教学" }));
    expect(
      screen.getByRole("heading", { name: "暗子是怎么翻面的？" }),
    ).toBeInTheDocument();
    expect(screen.getByText("先点一下红色暗子")).toBeInTheDocument();

    await user.click(screen.getByTestId("square-4-6"));
    expect(screen.getByTestId("square-4-5")).toHaveClass("is-legal");
    expect(screen.getByText("再点棋盘上的绿色落点")).toBeInTheDocument();

    await user.click(screen.getByTestId("square-4-5"));
    expect(screen.getByText("它真正的身份是黑車")).toBeInTheDocument();
    expect(screen.getByText("車")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /我明白了，开始游戏/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "这局，和谁下？" }),
    ).toBeInTheDocument();
  });

  it("人人对战通过设置弹窗开局，并移除冗余标签与版本信息", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const { container } = render(<App api={api} />);

    await startHumanGame(user, api);
    expect(api.createGame).toHaveBeenCalledWith({
      mode: "standard",
      allowDraw: true,
      allowUndo: true,
      matchType: "human-human",
    });
    expect(screen.getAllByText("Player 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Player 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("随机分配")).not.toBeInTheDocument();
    expect(screen.queryByText("跨平台复现")).not.toBeInTheDocument();
    expect(screen.queryByText(/局面版本/)).not.toBeInTheDocument();
    expect(screen.queryByText("本局提示")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "象棋棋盘" })).toHaveAttribute(
      "data-bottom-side",
      "red",
    );

    const coveredFace = container.querySelector(".piece-back");
    expect(coveredFace).not.toBeNull();
    expect(coveredFace).toHaveTextContent("");
    expect(screen.getByText("帥")).toBeInTheDocument();
    expect(screen.getByText("將")).toBeInTheDocument();
  });

  it("指定 Seed 在活动局保密，终局后公开并可同 Seed 重开", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);

    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /选择双人对战/ }));
    await user.click(screen.getByRole("radio", { name: /吃主帅模式/ }));
    await user.click(screen.getByRole("switch", { name: "允许自动和棋" }));
    await user.click(screen.getByRole("switch", { name: "允许悔棋" }));
    await user.click(screen.getByRole("button", { name: "指定 Seed" }));
    await user.type(screen.getByLabelText(/输入 Seed/), "  Debug-棋局-01  ");
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    await waitFor(() =>
      expect(api.createGame).toHaveBeenCalledWith({
        mode: "capture-general",
        allowDraw: false,
        allowUndo: false,
        matchType: "human-human",
        seed: "Debug-棋局-01",
      }),
    );
    expect(
      await screen.findByText("进行中保密 · 终局后公开"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Debug-棋局-01")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "吃主帅模式" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "终局后可同 Seed 再来" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "当前方认输" }));
    await user.click(screen.getByRole("button", { name: /确认红方认输/ }));
    const result = await screen.findByRole("dialog", { name: "黑方胜" });
    expect(within(result).getByText("Debug-棋局-01")).toBeInTheDocument();
    await user.click(
      within(result).getByRole("button", { name: "同 Seed 再来" }),
    );
    await waitFor(() => expect(api.createGame).toHaveBeenCalledTimes(2));
    expect(api.createGame).toHaveBeenLastCalledWith({
      mode: "capture-general",
      allowDraw: false,
      allowUndo: false,
      matchType: "human-human",
      seed: "Debug-棋局-01",
    });
  });

  it("点击棋子显示合法落点，提交后展示翻面结果", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await startHumanGame(user, api);

    await user.click(screen.getByTestId("square-0-6"));
    expect(screen.getByTestId("square-0-5")).toHaveClass("is-legal");
    expect(screen.getByText(/有 1 个合法落点/)).toBeInTheDocument();

    await user.click(screen.getByTestId("square-0-5"));
    await waitFor(() => {
      // 同屏对局没有座位令牌，因此第 5 个参数是 undefined。
      expect(api.move).toHaveBeenCalledWith(
        "game-ui",
        { x: 0, y: 6 },
        { x: 0, y: 5 },
        0,
        undefined,
      );
    });
    expect(await screen.findByText("揭晓为黑方車")).toBeInTheDocument();
    expect(screen.getByText("Player 2 行棋")).toBeInTheDocument();
  });

  it("开启悔棋后可撤回最近一步并恢复落子前局面", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await startHumanGame(user, api);

    expect(screen.getByRole("button", { name: "悔棋" })).toBeDisabled();
    await user.click(screen.getByTestId("square-0-6"));
    await user.click(screen.getByTestId("square-0-5"));
    expect(await screen.findByRole("button", { name: "悔棋" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "悔棋" }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith("game-ui", 1));
    expect(screen.getByText("Player 1 行棋")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "悔棋" })).toBeDisabled();
    expect(
      screen.getByTestId("square-0-6").querySelector(".piece-back"),
    ).not.toBeNull();
  });

  it("普通落子先播放对应棋种的移动层，再揭面落位", async () => {
    enableVisualMotion();
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await startHumanGame(user, api);

    await user.click(screen.getByTestId("square-0-6"));
    await user.click(screen.getByTestId("square-0-5"));

    const movingPiece = await screen.findByTestId("motion-piece");
    expect(movingPiece).toHaveClass("motion-piece--pawn");
    expect(movingPiece).not.toHaveTextContent("覆");
    await waitFor(
      () =>
        expect(screen.queryByTestId("motion-piece")).not.toBeInTheDocument(),
      { timeout: 1_200 },
    );
    expect(screen.getByText("車")).toBeInTheDocument();
  });

  it("吃子时显示被吃棋子的真实字形、冲击层与消散过程", async () => {
    enableVisualMotion();
    const user = userEvent.setup();
    const api = createMockApi();
    const captureStart: PublicGameState = {
      ...initialGame,
      board: [
        initialGame.board[0],
        {
          id: "red-rook",
          position: { x: 0, y: 5 },
          faceUp: true,
          publicIdentity: { color: "red", type: "rook" },
          identity: { color: "red", type: "rook" },
          controller: "red",
        },
        {
          id: "covered-target",
          position: { x: 0, y: 3 },
          faceUp: false,
          publicIdentity: { color: "black", type: "cannon" },
          controller: "black",
        },
        initialGame.board[2],
      ],
    };
    const capturedPiece = {
      id: "covered-target",
      identity: { color: "black" as const, type: "horse" as const },
      publicIdentity: { color: "black" as const, type: "cannon" as const },
      capturedBy: "red" as const,
      moveNumber: 1,
    };
    const captureEnd: PublicGameState = {
      ...captureStart,
      revision: 1,
      moveNumber: 1,
      turn: "black",
      board: captureStart.board
        .filter((piece) => piece.id !== "covered-target")
        .map((piece) =>
          piece.id === "red-rook"
            ? { ...piece, position: { x: 0, y: 3 } }
            : piece,
        ),
      captured: { red: [capturedPiece], black: [] },
      lastMove: {
        pieceId: "red-rook",
        from: { x: 0, y: 5 },
        to: { x: 0, y: 3 },
        capturedPiece,
      },
    };
    api.createGame = vi.fn(async () => captureStart);
    api.getLegalMoves = vi.fn(async (id: string) => ({
      gameId: id,
      revision: 0,
      turn: "red" as const,
      moves: [
        {
          pieceId: "red-rook",
          from: { x: 0, y: 5 },
          to: { x: 0, y: 3 },
          captures: true,
        },
      ],
    }));
    api.move = vi.fn(async () => captureEnd);
    render(<App api={api} />);
    await startHumanGame(user, api);

    await user.click(screen.getByTestId("square-0-5"));
    await user.click(screen.getByTestId("square-0-3"));

    expect(await screen.findByTestId("motion-piece")).toHaveClass(
      "motion-piece--rook",
      "motion-piece--capture",
    );
    expect(screen.getByTestId("capture-target")).toHaveTextContent("馬");
    expect(
      screen.getByTestId("capture-target").querySelector(".capture-burst"),
    ).not.toBeNull();
    await waitFor(
      () =>
        expect(screen.queryByTestId("capture-target")).not.toBeInTheDocument(),
      { timeout: 1_300 },
    );
    expect(screen.getByTitle("第 1 手吃得")).toHaveTextContent("馬");
    expect(screen.getByText("俥")).toBeInTheDocument();
  });

  it("没有配置 Ollama 时显示接口就绪状态，并允许重新检测", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);

    expect(
      await screen.findByText("接口已就绪，尚未检测到本机模型"),
    ).toBeInTheDocument();
    const aiStart = screen.getByRole("button", { name: /等待本机模型/ });
    expect(aiStart).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(api.getAiModels).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /选择双人对战/ })).toBeEnabled();
  });

  it("人机对战创建独立控制会话，AI 红方由轮询刷新而非网页代走", async () => {
    const user = userEvent.setup();
    const api = createMockApi({
      provider: "ollama",
      available: true,
      models: [{ name: "qwen-local:latest", parameterSize: "7B" }],
      message: "已发现 1 个本机模型。",
    });
    const aiFirstGame: PublicGameState = {
      ...initialGame,
      matchType: "human-ai",
      aiModel: "qwen-local:latest",
      players: { player1: "black", player2: "red" },
    };
    const afterAiMove: PublicGameState = {
      ...aiFirstGame,
      revision: 1,
      moveNumber: 1,
      turn: "black",
      lastMove: {
        pieceId: "hidden-pawn",
        from: { x: 0, y: 6 },
        to: { x: 0, y: 5 },
      },
    };
    api.createGame = vi.fn(async () => aiFirstGame);
    api.getGame = vi.fn(async () => afterAiMove);
    api.createAgentSession = vi.fn(async () => ({
      sessionId: "00000000-0000-4000-8000-000000000002",
      gameId: "game-ui",
      status: "thinking" as const,
      terminal: "terminal" as const,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      lastActivityAt: "2026-08-30T00:00:00.000Z",
      error: null,
      logPath: ".local/agent-logs/game-ui.jsonl",
    }));
    api.getLegalMoves = vi.fn(async (id: string) => ({
      gameId: id,
      revision: 1,
      turn: "black" as const,
      moves: [],
    }));
    render(<App api={api} />);
    await openModeMenu(user);

    expect(await screen.findByLabelText("选择本机模型")).toHaveValue(
      "qwen-local:latest",
    );
    await user.click(screen.getByRole("button", { name: /选择人机对战/ }));
    await user.click(screen.getByRole("button", { name: "指定 Seed" }));
    await user.type(screen.getByLabelText(/输入 Seed/), "AI-opening-01");
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    await waitFor(() =>
      expect(api.createAgentSession).toHaveBeenCalledWith("game-ui"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("思考中");
    expect(api.aiMove).not.toHaveBeenCalled();
    expect(
      await screen.findByText("你 行棋", {}, { timeout: 2_500 }),
    ).toBeInTheDocument();
    const board = screen.getByRole("region", { name: "象棋棋盘" });
    expect(board).toHaveAttribute("data-bottom-side", "black");
    expect(board.querySelector(".board-player--bottom")).toHaveTextContent(
      /你.*黑方.*行棋/,
    );
    expect(board.querySelector(".board-player--top")).toHaveTextContent(
      /qwen-local:latest.*红方/,
    );
    expect(screen.getByTestId("square-4-0")).toHaveStyle({
      left: "50%",
      top: "95%",
    });
    expect(screen.getByTestId("square-4-9")).toHaveStyle({
      left: "50%",
      top: "5%",
    });
    expect(screen.getByTestId("square-0-6")).toHaveStyle({
      left: "94%",
      top: "35%",
    });
    expect(api.createGame).toHaveBeenCalledWith({
      mode: "standard",
      allowDraw: true,
      allowUndo: true,
      matchType: "human-ai",
      aiModel: "qwen-local:latest",
      seed: "AI-opening-01",
    });
  });

  it("终端失败时展示可复制命令，并允许从暂停状态重启或停止", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const api = createMockApi({
      provider: "ollama",
      available: true,
      models: [{ name: "local-model" }],
      message: "已发现 1 个本机模型。",
    });
    const paused: AgentSessionState = {
      sessionId: "00000000-0000-4000-8000-000000000003",
      gameId: "game-ui",
      status: "paused",
      terminal: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      lastActivityAt: null,
      error: "没有检测到桌面终端。",
      manualCommand:
        "MASKED_XIANGQI_AGENT_SESSION_FILE=/safe/session node runner",
      logPath: ".local/agent-logs/game-ui.jsonl",
    };
    api.createAgentSession = vi.fn(async () => paused);
    api.restartAgentSession = vi.fn(async () => ({
      ...paused,
      status: "starting" as const,
      terminal: "terminal" as const,
      error: null,
    }));
    api.stopAgentSession = vi.fn(async () => ({
      ...paused,
      status: "stopped" as const,
      error: null,
    }));
    render(<App api={api} />);

    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /选择人机对战/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("已暂停");
    expect(screen.getByText("没有检测到桌面终端。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(writeText).toHaveBeenCalledWith(paused.manualCommand);

    await user.click(screen.getByRole("button", { name: "重启控制器" }));
    await waitFor(() =>
      expect(api.restartAgentSession).toHaveBeenCalledWith("game-ui"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("启动中");

    await user.click(screen.getByRole("button", { name: "停止控制器" }));
    await waitFor(() =>
      expect(api.stopAgentSession).toHaveBeenCalledWith("game-ui"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("已停止");
  });

  it("吃子区公开被吃暗子的真实棋子，认输仍需二次确认", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const gameWithCapturedPiece: PublicGameState = {
      ...initialGame,
      captured: {
        red: [
          {
            id: "captured-horse",
            identity: { color: "black", type: "horse" },
            publicIdentity: { color: "red", type: "pawn" },
            capturedBy: "red",
            moveNumber: 3,
          },
        ],
        black: [],
      },
    };
    api.createGame = vi.fn(async () => gameWithCapturedPiece);
    api.resign = vi.fn(async (): Promise<PublicGameState> => ({
      ...gameWithCapturedPiece,
      seed: "MX-UI-TEST-01",
      revision: 1,
      status: { phase: "finished", winner: "black", reason: "resignation" },
    }));
    render(<App api={api} />);
    await startHumanGame(user, api);

    expect(await screen.findByTitle("第 3 手吃得")).toHaveTextContent("馬");
    expect(screen.getByText("红方吃得 · 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "当前方认输" }));
    await user.click(screen.getByRole("button", { name: "确认红方认输" }));
    await waitFor(() =>
      expect(api.resign).toHaveBeenCalledWith("game-ui", 0, undefined),
    );

    const result = await screen.findByRole("dialog", { name: "黑方胜" });
    expect(
      within(result).getByRole("heading", { name: "黑方胜" }),
    ).toBeInTheDocument();
    expect(within(result).getAllByText("认输")).toHaveLength(2);
    expect(within(result).getByText("MX-UI-TEST-01")).toBeInTheDocument();
    expect(within(result).getByText("1 枚")).toBeInTheDocument();
    await user.click(
      within(result).getByRole("button", { name: "查看最终棋盘" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "黑方胜" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "黑方胜" })).toBeInTheDocument();
  });

  it("九宫斜线只连接上下两个 3×3 宫格的四角", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await startHumanGame(user, api);

    const palace = screen.getByTestId("palace-grid");
    expect(palace.querySelector("path")).toHaveAttribute(
      "d",
      "M 39 5 L 61 25 M 61 5 L 39 25 M 39 75 L 61 95 M 61 75 L 39 95",
    );
  });

  it("合法着法失败时显示重试并自动恢复同一 revision", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.getLegalMoves).mockRejectedValueOnce(
      new Error("temporary legal move failure"),
    );
    render(<App api={api} />);

    await startHumanGame(user, api);
    expect(
      await screen.findByText("合法着法加载失败：temporary legal move failure"),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          vi.mocked(api.getLegalMoves).mock.calls.length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 2_500 },
    );
    await waitFor(() =>
      expect(
        screen.queryByText("合法着法加载失败：temporary legal move failure"),
      ).not.toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("square-0-6"));
    expect(screen.getByTestId("square-0-5")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("合法落点"),
    );
  });

  it("轮询保持单请求飞行，离开页面会 Abort 并拒绝旧响应回写", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    let capturedSignal: AbortSignal | undefined;
    let resolveRequest!: (game: PublicGameState) => void;
    vi.mocked(api.getGame).mockImplementation(
      async (_id, signal) =>
        new Promise<PublicGameState>((resolve) => {
          capturedSignal = signal;
          resolveRequest = resolve;
        }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App api={api} />);
    await startHumanGame(user, api);

    await waitFor(() => expect(api.getGame).toHaveBeenCalledOnce(), {
      timeout: 1_800,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(api.getGame).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "← 返回" }));
    expect(capturedSignal?.aborted).toBe(true);
    resolveRequest(movedGame);
    expect(
      await screen.findByRole("heading", { name: "这局，和谁下？" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "象棋棋盘" }),
    ).not.toBeInTheDocument();
  });
});

describe("局域网对战界面", () => {
  /**
   * This environment exposes Node's `localStorage` stub, whose methods are
   * missing — which is why the rest of the file calls `removeItem?.()`. The
   * seat record is genuine state the LAN UI depends on, so install a real
   * in-memory store for these tests and restore the original afterwards.
   */
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, "localStorage", original);
  });

  const createRoom = async (
    user: ReturnType<typeof userEvent.setup>,
    api: GameApi,
  ) => {
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));
    await waitFor(() => expect(api.createRoom).toHaveBeenCalled());
  };

  const saveRecoverableSeat = (
    gameId = "recoverable-lan-game",
    token = "recoverable-seat-token",
  ) => {
    store.set(
      "masked-xiangqi:lan-seat",
      JSON.stringify({
        gameId,
        color: "red",
        token,
        savedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    store.set("masked-xiangqi:last-game-id", gameId);
  };

  it("建房后展示房间码，并在对手入座前锁住棋盘", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await createRoom(user, api);

    expect(await screen.findByTestId("lan-room-code")).toHaveTextContent(
      "ABC234",
    );
    // 状态胶囊与棋盘遮罩都会提示，各查各的。
    expect(screen.getByRole("status")).toHaveTextContent("等待对手加入");
    expect(screen.getByRole("alert")).toHaveTextContent("等待对手加入");
    // 座位令牌绝不出现在界面上。
    expect(document.body.textContent).not.toContain("host-token");
    // 建房请求不带 matchType：局域网对局只能由 /rooms 创建。
    expect(api.createRoom).toHaveBeenCalledWith(
      expect.not.objectContaining({ matchType: expect.anything() }),
    );
  });

  it("替补座位仍为空时不会启用必然被服务端拒绝的悔棋请求", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.createRoom).mockResolvedValue({
      game: lanGame({
        guestClaimed: false,
        revision: 1,
        moveNumber: 1,
        turn: "black",
        canUndo: true,
        viewer: { status: "valid", color: "red" },
      }),
      roomCode: "ABC234",
      seat: { color: "red", token: "host-token" },
    });

    render(<App api={api} />);
    await createRoom(user, api);

    const undo = await screen.findByRole("button", { name: "请求悔棋" });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAttribute("title", "等待对手加入后才能请求悔棋");
    await user.click(undo);
    expect(api.requestUndo).not.toHaveBeenCalled();
  });

  it("终局后不再用失效的等待房间遮罩挡住最终棋盘", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.createRoom).mockResolvedValue({
      game: lanGame({
        guestClaimed: false,
        revision: 1,
        status: {
          phase: "finished",
          winner: "black",
          reason: "resignation",
        },
        viewer: { status: "valid", color: "red" },
      }),
      roomCode: "ABC234",
      seat: { color: "red", token: "host-token" },
    });

    render(<App api={api} />);
    await createRoom(user, api);
    const result = await screen.findByRole("dialog");
    const reviewButtons = within(result).getAllByRole("button", {
      name: "查看最终棋盘",
    });
    expect(reviewButtons).toHaveLength(1);
    await user.click(reviewButtons[0]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".lan-block")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("房间已结束");
    expect(screen.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
  });

  it("localStorage 写入失败时仍可持令牌对弈并在终局后换局", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    window.localStorage.setItem = () => {
      throw new DOMException("storage denied", "SecurityError");
    };
    vi.mocked(api.createRoom).mockResolvedValue({
      game: lanGame(),
      roomCode: "ABC234",
      seat: { color: "red", token: "host-token" },
    });

    render(<App api={api} />);
    await createRoom(user, api);
    const resign = await screen.findByRole("button", { name: "认输" });
    await user.click(resign);
    await user.click(screen.getByRole("button", { name: "确认红方认输" }));
    await waitFor(() =>
      expect(api.resign).toHaveBeenCalledWith("game-ui", 0, "host-token"),
    );

    await user.click(
      await screen.findByRole("button", { name: "返回对战选择" }),
    );
    expect(
      await screen.findByRole("heading", { name: "这局，和谁下？" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));
    await waitFor(() => expect(api.createRoom).toHaveBeenCalledTimes(2));
  });

  it("多网卡房主看到全部邀请地址及逐项复制入口", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.getNetwork).mockResolvedValue({
      mode: "lan",
      targetMode: "lan",
      port: 3001,
      addresses: ["10.0.0.5", "192.168.1.5"],
      error: null,
      pending: false,
      listening: true,
      local: true,
    });
    render(<App api={api} />);
    await createRoom(user, api);

    expect(screen.getByText("请选择与对手处在同一网段的地址：")).toBeVisible();
    for (const address of ["10.0.0.5", "192.168.1.5"]) {
      expect(
        screen.getByText(`http://${address}:3001/?room=ABC234`),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: `复制 ${address} 邀请链接` }),
      ).toBeVisible();
    }
  });

  it("房主执红时棋盘红方在下，客人加入后底部换成自己的一方", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await createRoom(user, api);
    expect(screen.getByRole("region", { name: "象棋棋盘" })).toHaveAttribute(
      "data-bottom-side",
      "red",
    );
  });

  it("客人通过房间码加入后执黑，棋盘翻转且看不到房间码", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /我有房间码/ }));
    // 输入会被归一化：小写与分隔符都能接受。
    await user.type(screen.getByLabelText("房间码"), "abc-234");
    await user.click(screen.getByRole("button", { name: "加入对局" }));

    await waitFor(() => expect(api.joinRoom).toHaveBeenCalledWith("ABC234"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "象棋棋盘" })).toHaveAttribute(
        "data-bottom-side",
        "black",
      ),
    );
    expect(screen.queryByTestId("lan-room-code")).not.toBeInTheDocument();
  });

  it("粘贴带分隔符的完整房间码时先归一化而不会被原始长度截断", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /我有房间码/ }));

    const input = screen.getByLabelText("房间码");
    expect(input).not.toHaveAttribute("maxlength");
    fireEvent.change(input, { target: { value: "ABC-234" } });
    expect(input).toHaveValue("ABC234");
    await user.click(screen.getByRole("button", { name: "加入对局" }));
    await waitFor(() => expect(api.joinRoom).toHaveBeenCalledWith("ABC234"));
  });

  it("邀请链接会直接打开已预填并已从地址栏移除的加入框", async () => {
    window.history.replaceState(null, "", "/?room=abc-234");
    render(<App api={createMockApi()} />);

    expect(
      await screen.findByRole("dialog", { name: "加入局域网对局" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("房间码")).toHaveValue("ABC234");
    expect(window.location.search).toBe("");
  });

  it("不是自己的回合时棋盘不可操作，也不会发出落子请求", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /我有房间码/ }));
    await user.type(screen.getByLabelText("房间码"), "ABC234");
    await user.click(screen.getByRole("button", { name: "加入对局" }));
    await waitFor(() => expect(api.joinRoom).toHaveBeenCalled());

    // 客人执黑，但轮到红方。
    await waitFor(() =>
      expect(screen.getByTestId("square-0-6")).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    await user.click(screen.getByTestId("square-0-6"));
    expect(api.move).not.toHaveBeenCalled();
  });

  it("轮询到对手的悔棋请求时弹出协商，同意会调用 resolveUndo", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await createRoom(user, api);

    // 对手发起请求；这不改变 revision，只能靠房间状态变化被识别。
    api.getGame = vi.fn(async () =>
      lanGame({
        undoRequest: {
          id: "undo-request-1",
          requestedBy: "black",
          atRevision: 0,
          expiresAt: "2026-09-01T00:01:00.000Z",
        },
      }),
    );

    expect(
      await screen.findByText(/对手请求撤回/, undefined, { timeout: 2_500 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "同意悔棋" }));
    await waitFor(() =>
      expect(api.resolveUndo).toHaveBeenCalledWith(
        "game-ui",
        0,
        "undo-request-1",
        true,
        "host-token",
      ),
    );
  });

  it("对手断线时房主看到提示并可以重新邀请", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await createRoom(user, api);

    api.getGame = vi.fn(async () => lanGame({ guestOnline: false }));
    expect(
      await screen.findByText("对手已断线", undefined, { timeout: 2_500 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /重新邀请/ }));
    await waitFor(() =>
      expect(api.reinvite).toHaveBeenCalledWith(
        "game-ui",
        0,
        "ABC234",
        "host-token",
      ),
    );
  });

  it("座位被收回后显示已被移出，而不是含糊的报错", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /我有房间码/ }));
    await user.type(screen.getByLabelText("房间码"), "ABC234");
    await user.click(screen.getByRole("button", { name: "加入对局" }));
    await waitFor(() => expect(api.joinRoom).toHaveBeenCalled());

    // 替补已占据同一颜色时，旧令牌仍由 viewer 状态明确标为撤销。
    api.getGame = vi.fn(async () =>
      lanGame({
        guestClaimed: true,
        includeCode: false,
        revision: 1,
        moveNumber: 1,
        turn: "red",
        canUndo: true,
        undoRequest: {
          id: "revoked-seat-undo",
          requestedBy: "red",
          atRevision: 1,
          expiresAt: "2026-09-01T00:01:00.000Z",
        },
        viewer: { status: "revoked" },
      }),
    );
    expect(
      await screen.findByText("你已被移出对局", undefined, { timeout: 2_500 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请求悔棋" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "同意悔棋" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "象棋棋盘" })).toHaveAttribute(
      "data-bottom-side",
      "red",
    );
    expect(screen.getAllByText("房主").length).toBeGreaterThan(0);
  });

  it("未加载的恢复席位经过模式页导航仍保留并可继续恢复", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat();
    // Prove that the seat record alone reconstructs the Resume entry.
    store.delete("masked-xiangqi:last-game-id");
    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "recoverable-lan-game",
        viewer: { status: "valid", color: "red" },
      }),
    );

    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: "← 返回" }));

    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);
    expect(store.get("masked-xiangqi:last-game-id")).toBe(
      "recoverable-lan-game",
    );
    await user.click(screen.getByRole("button", { name: "恢复上局" }));
    await waitFor(() =>
      expect(api.getGame).toHaveBeenCalledWith(
        "recoverable-lan-game",
        undefined,
        "recoverable-seat-token",
      ),
    );
    expect(
      await screen.findByRole("region", { name: "象棋棋盘" }),
    ).toBeVisible();
  });

  it("创建新房间前先确认并结束仍可恢复的旧 LAN 房间", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat();
    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "recoverable-lan-game",
        revision: 4,
        viewer: { status: "valid", color: "red" },
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    await waitFor(() =>
      expect(api.resign).toHaveBeenCalledWith(
        "recoverable-lan-game",
        4,
        "recoverable-seat-token",
      ),
    );
    await waitFor(() => expect(api.createRoom).toHaveBeenCalledOnce());
    expect(vi.mocked(api.resign).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.createRoom).mock.invocationCallOrder[0],
    );
    expect(confirm).toHaveBeenCalledWith(
      "你还有一局可恢复的局域网对局。开始新局将视为认输并结束旧房间，是否继续？",
    );
    expect(JSON.parse(store.get("masked-xiangqi:lan-seat")!)).toMatchObject({
      gameId: "game-ui",
      token: "host-token",
    });
  });

  it("旧座位墓碑写入失败时中止换局并保留恢复凭据", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat();
    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "recoverable-lan-game",
        status: {
          phase: "finished",
          winner: "black",
          reason: "resignation",
        },
        viewer: { status: "valid", color: "red" },
      }),
    );
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (key: string, value: string) => {
      if (key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX)) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    };

    render(<App api={api} />);
    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    expect(
      await screen.findByText(
        "浏览器无法安全更新局域网座位记录，请释放站点存储空间后重试。",
      ),
    ).toBeInTheDocument();
    expect(api.createRoom).not.toHaveBeenCalled();
    expect(JSON.parse(store.get("masked-xiangqi:lan-seat")!)).toMatchObject({
      gameId: "recoverable-lan-game",
      token: "recoverable-seat-token",
    });
    expect(store.get("masked-xiangqi:last-game-id")).toBe(
      "recoverable-lan-game",
    );
  });

  it("换局前采用另一标签页写入的更新座位而不是覆盖它", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat("stale-tab-game", "stale-tab-token");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App api={api} />);
    // This tab still has stale-tab-game in its React ref. A second tab has
    // already ended that room and minted this later one-time credential.
    writeSeatRecord({
      gameId: "newer-tab-game",
      color: "red",
      token: "newer-tab-token",
      savedAt: "2026-09-01T00:02:00.000Z",
    });
    store.set("masked-xiangqi:last-game-id", "newer-tab-game");
    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "newer-tab-game",
        revision: 7,
        viewer: { status: "valid", color: "red" },
      }),
    );

    await openModeMenu(user);
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));

    await waitFor(() =>
      expect(api.getGame).toHaveBeenCalledWith(
        "newer-tab-game",
        undefined,
        "newer-tab-token",
      ),
    );
    expect(api.getGame).not.toHaveBeenCalledWith(
      "stale-tab-game",
      undefined,
      "stale-tab-token",
    );
    await waitFor(() =>
      expect(api.resign).toHaveBeenCalledWith(
        "newer-tab-game",
        7,
        "newer-tab-token",
      ),
    );
    await waitFor(() => expect(api.createRoom).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledOnce();
    expect(JSON.parse(store.get("masked-xiangqi:lan-seat")!)).toMatchObject({
      gameId: "game-ui",
      token: "host-token",
    });
  });

  it("恢复时的瞬时断连保留按钮与一次性席位，随后可以重试", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat();
    vi.mocked(api.getGame).mockRejectedValueOnce(
      new TypeError("listener rebinding"),
    );

    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "恢复上局" }));
    expect(await screen.findByText("listener rebinding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复上局" })).toBeEnabled();
    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);
    expect(store.get("masked-xiangqi:last-game-id")).toBe(
      "recoverable-lan-game",
    );

    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "recoverable-lan-game",
        viewer: { status: "valid", color: "red" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "恢复上局" }));
    expect(
      await screen.findByRole("region", { name: "象棋棋盘" }),
    ).toBeVisible();
  });

  it("明确 GAME_NOT_FOUND 才会丢弃失效的恢复席位", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat();
    vi.mocked(api.getGame).mockRejectedValue(
      new ApiClientError(404, "GAME_NOT_FOUND", "没有找到该对局。"),
    );

    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "恢复上局" }));
    expect(await screen.findByText("没有找到该对局。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "恢复上局" }),
    ).not.toBeInTheDocument();
    expect(readSeatRecord()).toBeNull();
    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);
    expect(
      [...store.keys()].some((key) =>
        key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX),
      ),
    ).toBe(true);
    expect(store.has("masked-xiangqi:last-game-id")).toBe(false);
  });

  it("旧恢复请求返回不存在时保留另一标签页刚签发的座位", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    saveRecoverableSeat("stale-tab-game", "stale-tab-token");
    vi.mocked(api.getGame).mockImplementationOnce(async () => {
      writeSeatRecord({
        gameId: "replacement-tab-game",
        color: "black",
        token: "replacement-tab-token",
        savedAt: "2026-09-01T00:03:00.000Z",
      });
      store.set("masked-xiangqi:last-game-id", "replacement-tab-game");
      throw new ApiClientError(404, "GAME_NOT_FOUND", "没有找到该对局。");
    });

    render(<App api={api} />);
    await user.click(screen.getByRole("button", { name: "恢复上局" }));

    expect(await screen.findByText("没有找到该对局。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复上局" })).toBeEnabled();
    expect(store.get("masked-xiangqi:last-game-id")).toBe(
      "replacement-tab-game",
    );

    vi.mocked(api.getGame).mockResolvedValue(
      lanGame({
        id: "replacement-tab-game",
        viewer: { status: "valid", color: "black" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "恢复上局" }));
    await waitFor(() =>
      expect(api.getGame).toHaveBeenLastCalledWith(
        "replacement-tab-game",
        undefined,
        "replacement-tab-token",
      ),
    );
  });

  it("房主离开活跃局时先以自己的座位认输，再清除一次性凭据", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App api={api} />);
    await createRoom(user, api);
    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);

    await user.click(screen.getByRole("button", { name: "← 返回" }));
    await waitFor(() =>
      expect(api.resign).toHaveBeenCalledWith("game-ui", 0, "host-token"),
    );
    expect(
      await screen.findByRole("heading", { name: "这局，和谁下？" }),
    ).toBeInTheDocument();
    expect(readSeatRecord()).toBeNull();
    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);
    expect(
      [...store.keys()].some((key) =>
        key.startsWith(LAN_SEAT_TOMBSTONE_PREFIX),
      ),
    ).toBe(true);
    expect(store.has("masked-xiangqi:last-game-id")).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "对局仍在进行。离开将视为认输并结束本局，是否继续？",
    );
  });

  it("结束 LAN 房间失败时不离页、不丢失座位与恢复入口", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.resign).mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App api={api} />);
    await createRoom(user, api);

    await user.click(screen.getByRole("button", { name: "← 返回" }));
    expect(
      await screen.findByText("离开对局失败：network unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "象棋棋盘" })).toBeVisible();
    expect(store.has("masked-xiangqi:lan-seat")).toBe(true);
    expect(store.has("masked-xiangqi:last-game-id")).toBe(true);
  });

  it("可以从模式页开关局域网监听", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<App api={api} />);
    await openModeMenu(user);

    const toggle = await screen.findByRole("switch", {
      name: "允许同一网络的设备连接",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    await waitFor(() => expect(api.setNetworkMode).toHaveBeenCalledWith("lan"));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("远程访客只能加入房间，所有本机建局入口都不可用", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    vi.mocked(api.getNetwork).mockResolvedValue({
      mode: "lan",
      targetMode: "lan",
      port: 0,
      addresses: [],
      error: null,
      pending: false,
      listening: true,
      local: false,
    });

    render(<App api={api} />);
    await openModeMenu(user);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", {
          name: "允许同一网络的设备连接",
        }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /选择双人对战/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /创建房间/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /我有房间码/ })).toBeEnabled();
  });

  it("窗口重新聚焦时刷新真实模式与全部邀请地址", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const lan: NetworkStatusResponse = {
      mode: "lan",
      targetMode: "lan",
      port: 3001,
      addresses: ["10.0.0.5", "192.168.1.5"],
      error: null,
      pending: false,
      listening: true,
      local: true,
    };
    render(<App api={api} />);
    await waitFor(() => expect(api.getNetwork).toHaveBeenCalledOnce());
    await openModeMenu(user);
    vi.mocked(api.getNetwork).mockResolvedValue(lan);

    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", {
          name: "允许同一网络的设备连接",
        }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    await user.click(screen.getByRole("button", { name: /创建房间/ }));
    await user.click(screen.getByRole("button", { name: /确认开局/ }));
    for (const address of lan.addresses) {
      expect(
        await screen.findByText(`http://${address}:3001/?room=ABC234`),
      ).toBeVisible();
    }
  });

  it("切换监听期间容忍短暂断连并按 150ms 轮询到真实完成", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const loopback: NetworkStatusResponse = {
      mode: "loopback",
      targetMode: "loopback",
      port: 3001,
      addresses: [],
      error: null,
      pending: false,
      listening: true,
      local: true,
    };
    const lan: NetworkStatusResponse = {
      ...loopback,
      mode: "lan",
      targetMode: "lan",
      addresses: ["192.168.1.5"],
    };
    vi.mocked(api.getNetwork)
      .mockResolvedValueOnce(loopback)
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockRejectedValueOnce(new TypeError("socket rebinding"))
      .mockResolvedValue(lan);

    render(<App api={api} />);
    await openModeMenu(user);
    const toggle = await screen.findByRole("switch", {
      name: "允许同一网络的设备连接",
    });
    await user.click(toggle);

    await waitFor(
      () => expect(toggle).toHaveAttribute("aria-checked", "true"),
      { timeout: 2_000 },
    );
    expect(api.getNetwork).toHaveBeenCalledTimes(4);
  });

  it("监听回滚失败会保持真实模式并显示明确错误", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const loopback: NetworkStatusResponse = {
      mode: "loopback",
      targetMode: "loopback",
      port: 3001,
      addresses: [],
      error: null,
      pending: false,
      listening: true,
      local: true,
    };
    vi.mocked(api.getNetwork)
      .mockResolvedValueOnce(loopback)
      .mockResolvedValue({
        ...loopback,
        error: "EACCES：无法绑定局域网地址",
      });

    render(<App api={api} />);
    await openModeMenu(user);
    const toggle = await screen.findByRole("switch", {
      name: "允许同一网络的设备连接",
    });
    await user.click(toggle);

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((alert) =>
          alert.textContent?.includes("EACCES：无法绑定局域网地址"),
        ),
      ).toBe(true);
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("监听状态持续 pending 超过五秒时明确提示确认超时", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    const loopback: NetworkStatusResponse = {
      mode: "loopback",
      targetMode: "loopback",
      port: 3001,
      addresses: [],
      error: null,
      pending: false,
      listening: true,
      local: true,
    };
    const pending: NetworkStatusResponse = {
      ...loopback,
      targetMode: "lan",
      pending: true,
    };
    vi.mocked(api.getNetwork)
      .mockResolvedValueOnce(loopback)
      .mockResolvedValue(pending);
    vi.mocked(api.setNetworkMode).mockResolvedValue(pending);

    render(<App api={api} />);
    await openModeMenu(user);
    const toggle = screen.getByRole("switch", {
      name: "允许同一网络的设备连接",
    });
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fireEvent.click(toggle);
    await act(async () => Promise.resolve());
    clock = 5_001;

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "监听切换确认超时",
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // The foreground timeout releases the UI, but background reconciliation
    // keeps polling and recovers as soon as the queued bind completes.
    vi.mocked(api.getNetwork).mockResolvedValue({
      ...loopback,
      mode: "lan",
      targetMode: "lan",
      addresses: ["192.168.1.5"],
    });
    await waitFor(
      () => {
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(toggle).not.toBeDisabled();
        expect(screen.queryByText(/监听切换确认超时/)).not.toBeInTheDocument();
      },
      { timeout: 2_000 },
    );
  });
});
