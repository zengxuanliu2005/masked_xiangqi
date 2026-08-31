// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSessionState,
  AiModelsResponse,
  CreateGameRequest,
  PublicGameState,
} from "../shared/contracts";
import { App } from "../src/App";
import type { GameApi } from "../src/api";

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
      expect(api.move).toHaveBeenCalledWith(
        "game-ui",
        { x: 0, y: 6 },
        { x: 0, y: 5 },
        0,
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
    await waitFor(() => expect(api.resign).toHaveBeenCalledWith("game-ui", 0));

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
