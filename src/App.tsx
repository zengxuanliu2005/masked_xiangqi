import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  COLOR_LABELS,
  MODE_LABELS,
  PIECE_LABELS,
  type AgentSessionState,
  type AiModelsResponse,
  type Color,
  type CreateGameRequest,
  type FinishReason,
  type GameMode,
  type LegalMove,
  type MatchType,
  type Position,
  type PublicBoardPiece,
  type PublicCapturedPiece,
  type PublicGameState,
} from "../shared/contracts";
import { ApiClientError, gameApi, type GameApi } from "./api";
import {
  deriveBoardMotion,
  prefersReducedBoardMotion,
  type BoardMotion,
} from "./motion";

type AppView = "home" | "mode" | "tutorial" | "game";
type SeedMode = "random" | "custom";

interface GameLaunchOptions {
  matchType: MatchType;
  mode: GameMode;
  allowDraw: boolean;
  allowUndo: boolean;
  seed?: string;
  model?: string;
}

const FILE_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const BOARD_COORDINATES = Array.from({ length: 90 }, (_, index) => ({
  x: index % 9,
  y: Math.floor(index / 9),
}));

const finishText: Record<FinishReason, string> = {
  checkmate: "将死",
  stalemate: "困毙",
  "general-captured": "主帅被吃",
  resignation: "认输",
  "threefold-repetition": "三次重复，和棋",
};

const controllerStatusText: Record<AgentSessionState["status"], string> = {
  starting: "启动中",
  "waiting-human": "等待人类",
  thinking: "思考中",
  submitting: "提交中",
  paused: "已暂停",
  finished: "已结束",
  stopped: "已停止",
  exited: "已退出",
};

const squareName = ({ x, y }: Position) => `${FILE_NAMES[x]}路 ${y + 1}线`;
const positionKey = ({ x, y }: Position) => `${x},${y}`;
const LAST_GAME_STORAGE_KEY = "masked-xiangqi:last-game-id";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
  busy: boolean,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const escapeRef = useRef(onEscape);
  const busyRef = useRef(busy);
  escapeRef.current = onEscape;
  busyRef.current = busy;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const returnFocusElement = returnFocusRef?.current ?? previouslyFocused;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backdrop = dialog.parentElement;
    const modalParent = backdrop?.parentElement;
    const inerted = modalParent
      ? [...modalParent.children]
          .filter(
            (element): element is HTMLElement =>
              element instanceof HTMLElement && element !== backdrop,
          )
          .map((element) => ({
            element,
            inert: element.inert,
            ariaHidden: element.getAttribute("aria-hidden"),
          }))
      : [];
    for (const entry of inerted) {
      entry.element.inert = true;
      entry.element.setAttribute("aria-hidden", "true");
    }
    queueMicrotask(() =>
      (
        initialFocusRef.current ??
        dialog.querySelector<HTMLElement>(focusableSelector)
      )?.focus(),
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter(
        (element) =>
          !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const entry of inerted) {
        entry.element.inert = entry.inert;
        if (entry.ariaHidden === null)
          entry.element.removeAttribute("aria-hidden");
        else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
      }
      // WebKit may discard a synchronous focus() issued while the Escape
      // keydown is still unwinding. Restore after React removes the modal and
      // the background has become interactive again.
      window.setTimeout(() => {
        if (returnFocusElement?.isConnected) {
          returnFocusElement.focus({ preventScroll: true });
        }
      }, 0);
    };
  }, [dialogRef, initialFocusRef, returnFocusRef]);
}

const copyText = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the local DOM copy path for older browser policies.
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand?.("copy") ?? false;
  field.remove();
  if (!copied) throw new Error("copy unavailable");
};

const pieceName = (piece: PublicBoardPiece): string => {
  if (!piece.faceUp) {
    const publicName =
      PIECE_LABELS[piece.publicIdentity.color][piece.publicIdentity.type];
    return `${COLOR_LABELS[piece.controller]}暗子（按${publicName}行走）`;
  }
  const identity = piece.identity!;
  return `${COLOR_LABELS[identity.color]}${PIECE_LABELS[identity.color][identity.type]}`;
};

const playerFor = (game: PublicGameState, color: Color): string => {
  if (game.players.player1 === color) {
    return game.matchType === "human-ai" ? "你" : "Player 1";
  }
  return game.matchType === "human-ai"
    ? (game.aiModel ?? "本机模型")
    : "Player 2";
};

function SiteHeader({
  view,
  onHome,
  onBack,
  routeLabel,
}: {
  view: AppView;
  onHome: () => void;
  onBack?: () => void;
  routeLabel?: string;
}) {
  return (
    <header className="site-header">
      <button className="brand" type="button" onClick={onHome}>
        <span className="brand-mark" aria-hidden="true">
          <i />
        </span>
        <span className="brand-copy">
          <strong>覆子</strong>
          <small>MASKED XIANGQI</small>
        </span>
      </button>
      {view === "home" ? (
        <div className="local-note">
          <span />
          仅在本机运行
        </div>
      ) : (
        <div className="header-route">
          {onBack && (
            <button type="button" className="quiet-button" onClick={onBack}>
              ← 返回
            </button>
          )}
          <span>
            {view === "mode"
              ? "选择对战"
              : view === "tutorial"
                ? "新手教学"
                : (routeLabel ?? "棋局进行中")}
          </span>
        </div>
      )}
    </header>
  );
}

function HomePage({
  onStart,
  onTutorial,
  onResume,
  canResume,
}: {
  onStart: () => void;
  onTutorial: () => void;
  onResume: () => void;
  canResume: boolean;
}) {
  return (
    <div className="landing-page">
      <SiteHeader view="home" onHome={() => undefined} />
      <main className="home-main">
        <section className="hero-section">
          <div className="hero-copy">
            <p className="eyebrow">位置是第一重身份，揭面才见真实阵营</p>
            <h1>
              一步以前，
              <br />
              敌我未定。
            </h1>
            <p className="hero-lead">
              一局带有未知与反转的中国象棋。暗子第一次按原位置行动，落子后揭晓真实棋子；红方始终先走。
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onStart}
              >
                开始游戏 <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="tutorial-button"
                onClick={onTutorial}
              >
                新手教学
              </button>
              {canResume && (
                <button
                  type="button"
                  className="tutorial-button"
                  onClick={onResume}
                >
                  恢复上局
                </button>
              )}
            </div>
          </div>
          <div className="hero-board" aria-hidden="true">
            <div className="hero-board-lines" />
            <span className="hero-piece hero-piece--black hero-piece--one" />
            <span className="hero-piece hero-piece--red hero-piece--two" />
            <span className="hero-piece hero-piece--open hero-piece--three">
              帥
            </span>
            <div className="hero-seal">盲棋</div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>覆子 · 本地象棋盲棋</span>
      </footer>
    </div>
  );
}

function GameSetupDialog({
  matchType,
  busy,
  seedMode,
  customSeed,
  gameMode,
  allowDraw,
  allowUndo,
  onSeedMode,
  onCustomSeed,
  onGameMode,
  onAllowDraw,
  onAllowUndo,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  matchType: MatchType;
  busy: boolean;
  seedMode: SeedMode;
  customSeed: string;
  gameMode: GameMode;
  allowDraw: boolean;
  allowUndo: boolean;
  onSeedMode: (mode: SeedMode) => void;
  onCustomSeed: (seed: string) => void;
  onGameMode: (mode: GameMode) => void;
  onAllowDraw: (allow: boolean) => void;
  onAllowUndo: (allow: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const seedReady = seedMode === "random" || Boolean(customSeed.trim());
  useModalFocus(dialogRef, closeButtonRef, onCancel, busy, returnFocusRef);

  return (
    <div
      className="setup-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className="setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-dialog-title"
        aria-describedby="setup-dialog-description"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (seedReady && !busy) onConfirm();
        }}
      >
        <header className="setup-dialog-header">
          <div>
            <p className="eyebrow">第 2 步 / 共 2 步</p>
            <h2 id="setup-dialog-title">设置这一局</h2>
            <p id="setup-dialog-description">
              {matchType === "human-ai" ? "人机对战" : "人人对战"} ·
              红黑随机分配 · 红方先行
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="setup-close"
            aria-label="关闭本局设置"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div className="setup-dialog-body">
          <section
            className="setup-section rule-setup-section"
            aria-labelledby="rule-setting-title"
          >
            <div className="setup-section-heading">
              <h3 id="rule-setting-title">胜负规则</h3>
            </div>
            <div className="rule-mode-options">
              {(["standard", "capture-general"] as const).map((mode) => (
                <label
                  className={`rule-mode-option ${gameMode === mode ? "is-selected" : ""}`}
                  key={mode}
                >
                  <input
                    type="radio"
                    name="game-mode"
                    value={mode}
                    checked={gameMode === mode}
                    onChange={() => onGameMode(mode)}
                  />
                  <strong>{MODE_LABELS[mode]}</strong>
                  <span>
                    {mode === "standard"
                      ? "保留将军、应将、送将和将帅照面约束。"
                      : "取消将军约束，以实际吃掉帅或将结束。"}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section
            className="setup-section play-options-setting"
            aria-label="对局选项"
          >
            <div className="setup-toggle-row">
              <div>
                <h3 id="draw-setting-title">允许自动和棋</h3>
                <p>同一局面第三次出现时自动判和；关闭后不判和。</p>
              </div>
              <button
                type="button"
                className={`switch-control ${allowDraw ? "is-on" : ""}`}
                role="switch"
                aria-checked={allowDraw}
                aria-label="允许自动和棋"
                onClick={() => onAllowDraw(!allowDraw)}
              >
                <span />
              </button>
            </div>

            <div className="setup-toggle-row">
              <div>
                <h3 id="undo-setting-title">允许悔棋</h3>
                <p>
                  {matchType === "human-ai"
                    ? "撤回玩家与模型的上一轮行棋。"
                    : "每次撤回最近完成的一步棋。"}
                </p>
              </div>
              <button
                type="button"
                className={`switch-control ${allowUndo ? "is-on" : ""}`}
                role="switch"
                aria-checked={allowUndo}
                aria-label="允许悔棋"
                onClick={() => onAllowUndo(!allowUndo)}
              >
                <span />
              </button>
            </div>
          </section>

          <section
            className="setup-section seed-setup-section"
            aria-labelledby="seed-setting-title"
          >
            <div className="setup-section-heading">
              <h3 id="seed-setting-title">开局 Seed</h3>
            </div>
            <p>相同 Seed 可在不同设备复现同一暗子排列。</p>
            <div className="seed-controls">
              <div
                className="seed-mode-picker"
                role="group"
                aria-label="Seed 生成方式"
              >
                <button
                  type="button"
                  aria-pressed={seedMode === "random"}
                  className={seedMode === "random" ? "is-active" : ""}
                  onClick={() => onSeedMode("random")}
                >
                  自动生成
                </button>
                <button
                  type="button"
                  aria-pressed={seedMode === "custom"}
                  className={seedMode === "custom" ? "is-active" : ""}
                  onClick={() => onSeedMode("custom")}
                >
                  指定 Seed
                </button>
              </div>
              {seedMode === "custom" && (
                <label className="seed-input-label" htmlFor="opening-seed">
                  <span>输入 Seed（区分大小写）</span>
                  <input
                    id="opening-seed"
                    value={customSeed}
                    maxLength={80}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="例如：MX-demo-2026"
                    onChange={(event) => onCustomSeed(event.target.value)}
                  />
                </label>
              )}
            </div>
          </section>
        </div>

        <footer className="setup-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            返回
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !seedReady}
          >
            {busy ? "正在开局…" : "确认开局"}
            <span aria-hidden="true">→</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function ModePage({
  aiStatus,
  selectedModel,
  loadingModels,
  busy,
  seedMode,
  customSeed,
  onSelectModel,
  onRefreshModels,
  onSeedMode,
  onCustomSeed,
  onStart,
  onHome,
}: {
  aiStatus: AiModelsResponse | null;
  selectedModel: string;
  loadingModels: boolean;
  busy: boolean;
  seedMode: SeedMode;
  customSeed: string;
  onSelectModel: (model: string) => void;
  onRefreshModels: () => void;
  onSeedMode: (mode: SeedMode) => void;
  onCustomSeed: (seed: string) => void;
  onStart: (options: GameLaunchOptions) => void;
  onHome: () => void;
}) {
  const [pendingMatch, setPendingMatch] = useState<MatchType | null>(null);
  const setupTriggerRef = useRef<HTMLButtonElement>(null);
  const [gameMode, setGameMode] = useState<GameMode>("standard");
  const [allowDraw, setAllowDraw] = useState(true);
  const [allowUndo, setAllowUndo] = useState(true);
  const selectedModelInfo = aiStatus?.models.find(
    (model) => model.name === selectedModel,
  );
  const canStartAi = Boolean(
    aiStatus?.available &&
    selectedModel &&
    selectedModelInfo?.supportsCompletion !== false,
  );
  const selectedSeed = seedMode === "custom" ? customSeed.trim() : undefined;
  const closeSetup = useCallback(() => setPendingMatch(null), []);

  const confirmSetup = () => {
    if (!pendingMatch) return;
    onStart({
      matchType: pendingMatch,
      mode: gameMode,
      allowDraw,
      allowUndo,
      ...(selectedSeed ? { seed: selectedSeed } : {}),
      ...(pendingMatch === "human-ai" ? { model: selectedModel } : {}),
    });
  };

  return (
    <div className="selection-page">
      <SiteHeader view="mode" onHome={onHome} onBack={onHome} />
      <main className="selection-main">
        <div className="selection-heading">
          <p className="eyebrow">第 1 步 / 共 2 步</p>
          <h1>这局，和谁下？</h1>
          <p>先选择对手，再设置规则与 Seed；开局后随机分配红黑，红方先走。</p>
        </div>

        <div className="mode-grid">
          <article className="mode-card mode-card--human">
            <div className="mode-number">01</div>
            <div className="mode-icon mode-icon--pair" aria-hidden="true">
              <i />
              <i />
            </div>
            <p className="mode-kicker">同屏轮流操作</p>
            <h2>人人对战</h2>
            <p>
              Player 1 与 Player 2
              在同一台设备上落子。系统随机分配红黑，适合面对面开一局。
            </p>
            <ul>
              <li>无需额外配置</li>
              <li>红方自动先行</li>
              <li>开局前选择规则</li>
            </ul>
            <button
              type="button"
              className="primary-button mode-start"
              disabled={busy}
              onClick={(event) => {
                setupTriggerRef.current = event.currentTarget;
                setPendingMatch("human-human");
              }}
            >
              选择双人对战 <span aria-hidden="true">→</span>
            </button>
          </article>

          <article className="mode-card mode-card--ai">
            <div className="mode-number">02</div>
            <div className="mode-icon mode-icon--model" aria-hidden="true">
              <i />
            </div>
            <p className="mode-kicker">连接本机 Ollama</p>
            <h2>人机对战</h2>
            <p>
              你与本地大模型对弈。模型只能看到公开局面和合法着法，不会获得未翻暗子的真实身份。
            </p>

            <div
              className={`model-status ${aiStatus?.available ? "is-ready" : ""}`}
            >
              {loadingModels ? (
                <div className="model-checking">
                  <span className="spinner" /> 正在检测本机模型…
                </div>
              ) : aiStatus?.available ? (
                <>
                  <label htmlFor="model-select">选择本机模型</label>
                  <select
                    id="model-select"
                    value={selectedModel}
                    onChange={(event) => onSelectModel(event.target.value)}
                  >
                    {aiStatus.models.map((model) => (
                      <option
                        value={model.name}
                        key={model.name}
                        disabled={model.supportsCompletion === false}
                      >
                        {model.name}
                        {model.parameterSize ? ` · ${model.parameterSize}` : ""}
                        {model.supportsThinking ? " · thinking" : ""}
                        {model.supportsCompletion === false
                          ? " · embedding（不可用于对弈）"
                          : ""}
                      </option>
                    ))}
                  </select>
                  <small>{aiStatus.message}</small>
                  {selectedModelInfo?.supportsCompletion === undefined && (
                    <small>
                      该模型的生成能力未由 Ollama 明确报告，开局时会再次验证。
                    </small>
                  )}
                </>
              ) : (
                <>
                  <strong>接口已就绪，尚未检测到本机模型</strong>
                  <p>{aiStatus?.message ?? "正在等待 Ollama 服务。"}</p>
                  <button type="button" onClick={onRefreshModels}>
                    重新检测
                  </button>
                </>
              )}
            </div>

            <button
              type="button"
              className="primary-button mode-start"
              disabled={busy || loadingModels || !canStartAi}
              onClick={(event) => {
                setupTriggerRef.current = event.currentTarget;
                setPendingMatch("human-ai");
              }}
            >
              {canStartAi ? "选择人机对战" : "等待本机模型"}
              <span aria-hidden="true">→</span>
            </button>
          </article>
        </div>
      </main>

      {pendingMatch && (
        <GameSetupDialog
          matchType={pendingMatch}
          busy={busy}
          seedMode={seedMode}
          customSeed={customSeed}
          gameMode={gameMode}
          allowDraw={allowDraw}
          allowUndo={allowUndo}
          onSeedMode={onSeedMode}
          onCustomSeed={onCustomSeed}
          onGameMode={setGameMode}
          onAllowDraw={setAllowDraw}
          onAllowUndo={setAllowUndo}
          onCancel={closeSetup}
          onConfirm={confirmSetup}
          returnFocusRef={setupTriggerRef}
        />
      )}
    </div>
  );
}

interface BoardProps {
  game: PublicGameState;
  legalMoves: LegalMove[];
  selectedId: string | null;
  motion: BoardMotion | null;
  arrivalPieceId: string | null;
  disabled: boolean;
  onSquare: (position: Position) => void;
}

function PieceDisc({
  piece,
  selected = false,
  arrived = false,
  extraClass = "",
}: {
  piece: PublicBoardPiece;
  selected?: boolean;
  arrived?: boolean;
  extraClass?: string;
}) {
  const color =
    piece.faceUp && piece.identity ? piece.identity.color : piece.controller;
  return (
    <span
      className={`piece ${piece.faceUp ? "piece--open" : "piece--covered"} piece--${color} ${
        selected ? "piece--selected" : ""
      } ${arrived ? "piece--arrived" : ""} ${extraClass}`}
      data-piece-type={
        piece.faceUp && piece.identity
          ? piece.identity.type
          : piece.publicIdentity.type
      }
      aria-hidden="true"
    >
      {piece.faceUp && piece.identity ? (
        PIECE_LABELS[piece.identity.color][piece.identity.type]
      ) : (
        <span className="piece-back" />
      )}
    </span>
  );
}

const boardLeft = (x: number, flipped: boolean) =>
  6 + (flipped ? 8 - x : x) * 11;
const boardTop = (y: number, flipped: boolean) =>
  5 + (flipped ? 9 - y : y) * 10;

function Board({
  game,
  legalMoves,
  selectedId,
  motion,
  arrivalPieceId,
  disabled,
  onSquare,
}: BoardProps) {
  const flipped = game.players.player1 === "black";
  const bottomColor: Color = flipped ? "black" : "red";
  const topColor: Color = bottomColor === "red" ? "black" : "red";
  const [focusedSquare, setFocusedSquare] = useState<Position>({
    x: 4,
    y: flipped ? 0 : 9,
  });
  const squareRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    setFocusedSquare({ x: 4, y: flipped ? 0 : 9 });
  }, [flipped, game.id]);
  const piecesBySquare = useMemo(
    () =>
      new Map(game.board.map((piece) => [positionKey(piece.position), piece])),
    [game.board],
  );
  const legalBySquare = useMemo(
    () => new Map(legalMoves.map((move) => [positionKey(move.to), move])),
    [legalMoves],
  );
  const lastSquares = useMemo(() => {
    if (!game.lastMove) return new Set<string>();
    return new Set([
      positionKey(game.lastMove.from),
      positionKey(game.lastMove.to),
    ]);
  }, [game.lastMove]);
  const motionStyle = motion
    ? ({
        left: `${boardLeft(motion.from.x, flipped)}%`,
        top: `${boardTop(motion.from.y, flipped)}%`,
        "--motion-to-left": `${boardLeft(motion.to.x, flipped)}%`,
        "--motion-to-top": `${boardTop(motion.to.y, flipped)}%`,
        "--motion-mid-left": `${boardLeft(motion.midpoint.x, flipped)}%`,
        "--motion-mid-top": `${boardTop(motion.midpoint.y, flipped)}%`,
        "--motion-leg-left": `${boardLeft(motion.horseLeg.x, flipped)}%`,
        "--motion-leg-top": `${boardTop(motion.horseLeg.y, flipped)}%`,
        "--motion-duration": `${motion.durationMs}ms`,
      } as CSSProperties)
    : undefined;

  const moveFocus = (position: Position, key: string) => {
    const horizontal = flipped ? -1 : 1;
    const vertical = flipped ? -1 : 1;
    const delta =
      key === "ArrowLeft"
        ? { x: -horizontal, y: 0 }
        : key === "ArrowRight"
          ? { x: horizontal, y: 0 }
          : key === "ArrowUp"
            ? { x: 0, y: -vertical }
            : { x: 0, y: vertical };
    const next = {
      x: Math.max(0, Math.min(8, position.x + delta.x)),
      y: Math.max(0, Math.min(9, position.y + delta.y)),
    };
    setFocusedSquare(next);
    squareRefs.current.get(positionKey(next))?.focus();
  };

  return (
    <section
      className="board-frame"
      aria-label="象棋棋盘"
      data-bottom-side={bottomColor}
    >
      <div className="board-player board-player--top">
        <span className={`side-dot side-dot--${topColor}`} />
        <strong>{playerFor(game, topColor)}</strong>
        <span>{COLOR_LABELS[topColor]}</span>
        {game.turn === topColor && game.status.phase === "active" && (
          <em>行棋</em>
        )}
      </div>
      <div
        className={`board-surface ${motion?.captures ? "is-capturing" : ""}`}
      >
        {Array.from({ length: 10 }, (_, y) => (
          <span
            aria-hidden="true"
            className="board-line board-line--horizontal"
            key={`h-${y}`}
            style={{ top: `${5 + y * 10}%` }}
          />
        ))}
        {Array.from({ length: 9 }, (_, x) =>
          x === 0 || x === 8 ? (
            <span
              aria-hidden="true"
              className="board-line board-line--vertical"
              key={`v-${x}`}
              style={{ left: `${6 + x * 11}%` }}
            />
          ) : (
            <span key={`v-${x}`}>
              <span
                aria-hidden="true"
                className="board-line board-line--vertical board-line--vertical-top"
                style={{ left: `${6 + x * 11}%` }}
              />
              <span
                aria-hidden="true"
                className="board-line board-line--vertical board-line--vertical-bottom"
                style={{ left: `${6 + x * 11}%` }}
              />
            </span>
          ),
        )}
        <svg
          className="palace-grid"
          data-testid="palace-grid"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M 39 5 L 61 25 M 61 5 L 39 25 M 39 75 L 61 95 M 61 75 L 39 95" />
        </svg>
        <div className="river" aria-hidden="true">
          <span>楚 河</span>
          <span>汉 界</span>
        </div>

        {BOARD_COORDINATES.map((position) => {
          const key = positionKey(position);
          const piece = piecesBySquare.get(key);
          const move = legalBySquare.get(key);
          const isSelected = piece?.id === selectedId;
          const style = {
            left: `${boardLeft(position.x, flipped)}%`,
            top: `${boardTop(position.y, flipped)}%`,
          } as CSSProperties;
          const baseLabel = piece
            ? `${pieceName(piece)}，${squareName(position)}`
            : `${squareName(position)}，空位`;
          const label = [
            baseLabel,
            isSelected ? "已选中" : "",
            move ? (move.captures ? "合法吃子落点" : "合法落点") : "",
            lastSquares.has(key) ? "最后一步经过位置" : "",
          ]
            .filter(Boolean)
            .join("，");

          return (
            <button
              type="button"
              className={`board-hit ${lastSquares.has(key) ? "is-last" : ""} ${
                move ? "is-legal" : ""
              } ${move?.captures ? "is-capture" : ""}`}
              style={style}
              key={key}
              data-testid={`square-${position.x}-${position.y}`}
              aria-label={label}
              aria-pressed={isSelected}
              aria-disabled={disabled}
              tabIndex={
                focusedSquare.x === position.x && focusedSquare.y === position.y
                  ? 0
                  : -1
              }
              ref={(element) => {
                if (element) squareRefs.current.set(key, element);
                else squareRefs.current.delete(key);
              }}
              onFocus={() => setFocusedSquare(position)}
              onKeyDown={(event) => {
                if (event.key.startsWith("Arrow")) {
                  event.preventDefault();
                  moveFocus(position, event.key);
                }
              }}
              onClick={() => {
                if (!disabled) onSquare(position);
              }}
            >
              {move && <span className="move-marker" aria-hidden="true" />}
              {piece && motion?.piece.id !== piece.id && (
                <PieceDisc
                  piece={piece}
                  selected={isSelected}
                  arrived={piece.id === arrivalPieceId}
                />
              )}
            </button>
          );
        })}

        {motion?.capturedPiece && (
          <span
            className="capture-target"
            data-testid="capture-target"
            style={
              {
                left: `${boardLeft(motion.to.x, flipped)}%`,
                top: `${boardTop(motion.to.y, flipped)}%`,
                "--motion-duration": `${motion.durationMs}ms`,
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <PieceDisc
              piece={motion.capturedPiece}
              extraClass="piece--captured"
            />
            <span className="capture-burst">
              <i />
              <i />
              <i />
              <i />
            </span>
          </span>
        )}

        {motion && (
          <span
            className={`motion-piece motion-piece--${motion.travelType} ${
              motion.captures ? "motion-piece--capture" : ""
            }`}
            data-testid="motion-piece"
            style={motionStyle}
            aria-hidden="true"
          >
            <span className="motion-trail" />
            <PieceDisc piece={motion.piece} extraClass="piece--in-motion" />
          </span>
        )}
      </div>
      <div className="board-player board-player--bottom">
        <span className={`side-dot side-dot--${bottomColor}`} />
        <strong>{playerFor(game, bottomColor)}</strong>
        <span>{COLOR_LABELS[bottomColor]}</span>
        {game.turn === bottomColor && game.status.phase === "active" && (
          <em>行棋</em>
        )}
      </div>
    </section>
  );
}

function TutorialPage({
  onHome,
  onStart,
}: {
  onHome: () => void;
  onStart: () => void;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const revealed = step === 2;
  const tutorialPiece: PublicBoardPiece = revealed
    ? {
        id: "tutorial-piece",
        position: { x: 4, y: 5 },
        faceUp: true,
        publicIdentity: { color: "red", type: "pawn" },
        identity: { color: "black", type: "rook" },
        controller: "black",
      }
    : {
        id: "tutorial-piece",
        position: { x: 4, y: 6 },
        faceUp: false,
        publicIdentity: { color: "red", type: "pawn" },
        controller: "red",
      };
  const tutorialGame: PublicGameState = {
    id: "tutorial",
    seed: null,
    mode: "standard",
    allowDraw: true,
    allowUndo: true,
    canUndo: revealed,
    matchType: "human-human",
    aiModel: null,
    revision: revealed ? 1 : 0,
    turn: revealed ? "black" : "red",
    moveNumber: revealed ? 1 : 0,
    players: { player1: "red", player2: "black" },
    status: { phase: "active", winner: null, reason: null },
    check: null,
    board: [
      {
        id: "tutorial-black-general",
        position: { x: 4, y: 0 },
        faceUp: true,
        publicIdentity: { color: "black", type: "general" },
        identity: { color: "black", type: "general" },
        controller: "black",
      },
      tutorialPiece,
      {
        id: "tutorial-red-general",
        position: { x: 4, y: 9 },
        faceUp: true,
        publicIdentity: { color: "red", type: "general" },
        identity: { color: "red", type: "general" },
        controller: "red",
      },
    ],
    captured: { red: [], black: [] },
    lastMove: revealed
      ? {
          pieceId: "tutorial-piece",
          from: { x: 4, y: 6 },
          to: { x: 4, y: 5 },
          revealedIdentity: { color: "black", type: "rook" },
        }
      : null,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  const tutorialMoves: LegalMove[] =
    step === 1
      ? [
          {
            pieceId: "tutorial-piece",
            from: { x: 4, y: 6 },
            to: { x: 4, y: 5 },
            captures: false,
          },
        ]
      : [];
  const instructions = [
    {
      title: "先点一下红色暗子",
      body: "它盖在红兵的原始位置，所以此刻由红方控制，也先按兵的走法行动。",
    },
    {
      title: "再点棋盘上的绿色落点",
      body: "这是它作为“兵”的合法一步。第一次行动完成后，棋子才会揭面。",
    },
    {
      title: "它真正的身份是黑車",
      body: "刚才那一步仍然有效；从下一回合开始，它归黑方控制，并改按車的走法行动。",
    },
  ] as const;

  const handleSquare = (position: Position) => {
    if (step === 0 && position.x === 4 && position.y === 6) {
      setStep(1);
    } else if (step === 1 && position.x === 4 && position.y === 5) {
      setStep(2);
    }
  };

  return (
    <div className="tutorial-page">
      <SiteHeader view="tutorial" onHome={onHome} onBack={onHome} />
      <main className="tutorial-main">
        <section className="tutorial-copy">
          <p className="eyebrow">亲手走一步</p>
          <h1>暗子是怎么翻面的？</h1>
          <div className="tutorial-instruction" aria-live="polite">
            <span>第 {step + 1} 步 / 共 3 步</span>
            <h2>{instructions[step].title}</h2>
            <p>{instructions[step].body}</p>
          </div>
          <ol className="tutorial-progress" aria-label="教学进度">
            {[
              ["选中", "按位置身份"],
              ["移动", "完成第一步"],
              ["揭面", "转换身份"],
            ].map(([title, detail], index) => (
              <li className={index <= step ? "is-active" : ""} key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </div>
              </li>
            ))}
          </ol>
          <div className="tutorial-actions">
            {step > 0 && (
              <button type="button" onClick={() => setStep(0)}>
                重新演示
              </button>
            )}
            <button
              type="button"
              className={step === 2 ? "primary-button" : ""}
              onClick={onStart}
            >
              {step === 2 ? "我明白了，开始游戏" : "跳过教学"}
              {step === 2 && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </section>

        <div
          className={`tutorial-board tutorial-board--${
            step === 0 ? "select" : step === 1 ? "move" : "revealed"
          }`}
        >
          <Board
            game={tutorialGame}
            legalMoves={tutorialMoves}
            selectedId={step === 1 ? "tutorial-piece" : null}
            motion={null}
            arrivalPieceId={revealed ? "tutorial-piece" : null}
            disabled={revealed}
            onSquare={handleSquare}
          />
          <p>
            {step === 0
              ? "请点击下方棋盘中间的红色实心棋子。"
              : step === 1
                ? "绿色圆点就是这枚暗子当前唯一要走的落点。"
                : "注意：棋子变成黑色文字后，控制方也随真实颜色改变。"}
          </p>
        </div>
      </main>
    </div>
  );
}

function CapturedTray({
  color,
  pieces,
  game,
}: {
  color: Color;
  pieces: PublicCapturedPiece[];
  game: PublicGameState;
}) {
  return (
    <section className={`captured-tray captured-tray--${color}`}>
      <div className="captured-heading">
        <div>
          <span className={`side-dot side-dot--${color}`} />
          <strong>{playerFor(game, color)}</strong>
        </div>
        <small>
          {COLOR_LABELS[color]}吃得 · {pieces.length}
        </small>
      </div>
      <div
        className="captured-pieces"
        aria-label={`${COLOR_LABELS[color]}吃掉的棋子`}
      >
        {pieces.length === 0 ? (
          <span className="captured-empty">尚未吃子</span>
        ) : (
          pieces.map((piece) => (
            <span
              className={`mini-piece mini-piece--${piece.identity.color}`}
              key={piece.id}
              title={`第 ${piece.moveNumber} 手吃得`}
            >
              {PIECE_LABELS[piece.identity.color][piece.identity.type]}
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function StatusCard({
  game,
  selected,
  legalCount,
  agentStatus,
}: {
  game: PublicGameState;
  selected?: PublicBoardPiece;
  legalCount: number;
  agentStatus?: AgentSessionState["status"];
}) {
  const finished = game.status.phase === "finished";
  const currentPlayer = playerFor(game, game.turn);

  return (
    <section
      className={`game-card status-card ${game.check ? "is-check" : ""}`}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {finished
          ? `对局结束，${game.status.winner ? `${COLOR_LABELS[game.status.winner]}胜` : "和棋"}`
          : `${COLOR_LABELS[game.turn]}行棋${game.check === game.turn ? "，当前被将军" : ""}`}
      </span>
      <p className="card-label">
        {finished
          ? `对局结束 · ${game.moveNumber} 手`
          : `第 ${game.moveNumber + 1} 手`}
      </p>
      {finished ? (
        <>
          <h2>
            {game.status.winner
              ? `${COLOR_LABELS[game.status.winner]}胜`
              : "和棋"}
          </h2>
          <p>
            {game.status.reason ? finishText[game.status.reason] : "对局结束"}
          </p>
        </>
      ) : (
        <>
          <h2>
            <span className={`turn-color turn-color--${game.turn}`}>
              {COLOR_LABELS[game.turn]}
            </span>
            <br />
            {agentStatus === "thinking"
              ? "本机模型思考中…"
              : agentStatus === "submitting"
                ? "本机模型提交中…"
                : `${currentPlayer} 行棋`}
          </h2>
          <p className={game.check ? "check-message" : ""}>
            {game.check === game.turn
              ? "将军！本手必须解除主帅威胁。"
              : selected
                ? `${pieceName(selected)}，有 ${legalCount} 个合法落点。`
                : "点击当前方棋子查看合法落点。"}
          </p>
        </>
      )}
    </section>
  );
}

function AgentControllerCard({
  session,
  busy,
  onReopen,
  onRestart,
  onStop,
}: {
  session: AgentSessionState | null;
  busy: boolean;
  onReopen: () => void;
  onRestart: () => void;
  onStop: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const status = session?.status;
  const canReopen = status === "exited" || status === "stopped";
  const canRestart = !session || status === "paused";
  const canStop = Boolean(
    session && status !== "stopped" && status !== "finished",
  );

  useEffect(() => setCopyState("idle"), [session?.manualCommand]);

  const copyManualCommand = async () => {
    if (!session?.manualCommand) return;
    try {
      await copyText(session.manualCommand);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section
      className={`game-card agent-controller-card agent-controller-card--${status ?? "starting"}`}
    >
      <div className="controller-heading">
        <p className="card-label">本地控制器</p>
        <span className="controller-state" role="status">
          <i /> {status ? controllerStatusText[status] : "启动中"}
        </span>
      </div>
      {session?.terminal && <small>终端：{session.terminal}</small>}
      {session?.error && <p role="alert">{session.error}</p>}
      {session?.manualCommand && (
        <div className="manual-command">
          <code title={session.manualCommand}>{session.manualCommand}</code>
          <button type="button" onClick={() => void copyManualCommand()}>
            {copyState === "copied" ? "已复制" : "复制命令"}
          </button>
          {copyState === "failed" && <small>复制失败，请手动选中。</small>}
        </div>
      )}
      <div className="controller-actions">
        <button type="button" disabled={busy || !canReopen} onClick={onReopen}>
          重新打开控制台
        </button>
        <button
          type="button"
          disabled={busy || !canRestart}
          onClick={onRestart}
        >
          重启控制器
        </button>
        <button type="button" disabled={busy || !canStop} onClick={onStop}>
          停止控制器
        </button>
      </div>
    </section>
  );
}

function AssignmentCard({ game }: { game: PublicGameState }) {
  return (
    <section className="game-card assignment-card">
      <div className="card-heading-row">
        <p className="card-label">本局执方</p>
      </div>
      <div className="assignment-row">
        <span className="side-dot side-dot--red" />
        <strong>红方</strong>
        <span>{playerFor(game, "red")}</span>
        <small>先行</small>
      </div>
      <div className="assignment-row">
        <span className="side-dot side-dot--black" />
        <strong>黑方</strong>
        <span>{playerFor(game, "black")}</span>
      </div>
    </section>
  );
}

function SeedCard({ seed }: { seed: string | null }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => setCopyState("idle"), [seed]);

  const handleCopy = async () => {
    if (!seed) return;
    try {
      await copyText(seed);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className="game-card seed-card">
      <div className="card-heading-row">
        <p className="card-label">本局 Seed</p>
      </div>
      <div className="seed-value-row">
        {seed ? (
          <>
            <code title={seed}>{seed}</code>
            <button type="button" onClick={() => void handleCopy()}>
              {copyState === "copied" ? "已复制" : "复制 Seed"}
            </button>
          </>
        ) : (
          <span className="seed-hidden">进行中保密 · 终局后公开</span>
        )}
      </div>
      {copyState === "failed" && (
        <small role="alert">复制失败，请手动选中 Seed。</small>
      )}
    </section>
  );
}

function LastMove({ game }: { game: PublicGameState }) {
  return (
    <section className="game-card last-move-card">
      <p className="card-label">最近一步</p>
      {!game.lastMove ? (
        <p className="empty-copy">尚未行棋，红方先走。</p>
      ) : (
        <>
          <strong>
            {squareName(game.lastMove.from)} → {squareName(game.lastMove.to)}
          </strong>
          {game.lastMove.revealedIdentity && (
            <span>
              揭晓为
              {COLOR_LABELS[game.lastMove.revealedIdentity.color]}
              {
                PIECE_LABELS[game.lastMove.revealedIdentity.color][
                  game.lastMove.revealedIdentity.type
                ]
              }
            </span>
          )}
          {game.lastMove.capturedPiece && (
            <span>
              吃得
              {COLOR_LABELS[game.lastMove.capturedPiece.identity.color]}
              {
                PIECE_LABELS[game.lastMove.capturedPiece.identity.color][
                  game.lastMove.capturedPiece.identity.type
                ]
              }
            </span>
          )}
        </>
      )}
    </section>
  );
}

function GameResultDialog({
  game,
  busy,
  onRestart,
  onReview,
  onLeave,
  onHome,
}: {
  game: PublicGameState;
  busy: boolean;
  onRestart: () => void;
  onReview: () => void;
  onLeave: () => void;
  onHome: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useModalFocus(dialogRef, primaryRef, onReview, busy);
  const winner = game.status.winner;
  const reason = game.status.reason
    ? finishText[game.status.reason]
    : "对局结束";
  const title = winner ? `${COLOR_LABELS[winner]}胜` : "和棋";
  const capturedCount = game.captured.red.length + game.captured.black.length;
  const winnerCopy = winner
    ? game.matchType === "human-ai" && game.players.player1 === winner
      ? "你拿下了这一局"
      : `${playerFor(game, winner)} 执${COLOR_LABELS[winner]}获胜`
    : "双方握手言和";

  return (
    <div className="result-backdrop">
      <section
        ref={dialogRef}
        className={`result-dialog ${winner ? `result-dialog--${winner}` : "result-dialog--draw"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-result-title"
        aria-describedby="game-result-description"
        tabIndex={-1}
      >
        <p className="result-eyebrow">对局结算 · GAME SETTLED</p>
        <div className="result-heading">
          <span className="result-seal" aria-hidden="true">
            {winner ? "胜" : "和"}
          </span>
          <div>
            <p id="game-result-description">{winnerCopy}</p>
            <h2 id="game-result-title">{title}</h2>
            <span>{reason}</span>
          </div>
        </div>

        <dl className="result-stats">
          <div>
            <dt>结束方式</dt>
            <dd>{reason}</dd>
          </div>
          <div>
            <dt>总手数</dt>
            <dd>{game.moveNumber}</dd>
          </div>
          <div>
            <dt>公开吃子</dt>
            <dd>{capturedCount} 枚</dd>
          </div>
        </dl>

        <div className="result-seed">
          <span>本局 Seed</span>
          <code>{game.seed ?? "终局 Seed 暂不可用"}</code>
        </div>

        <div className="result-actions">
          <button
            ref={primaryRef}
            type="button"
            className="result-primary"
            disabled={busy}
            onClick={onRestart}
          >
            同 Seed 再来
          </button>
          <button type="button" disabled={busy} onClick={onReview}>
            查看最终棋盘
          </button>
          <button type="button" disabled={busy} onClick={onLeave}>
            返回对战选择
          </button>
        </div>
        <button
          type="button"
          className="result-home"
          disabled={busy}
          onClick={onHome}
        >
          回到首页
        </button>
      </section>
    </div>
  );
}

function GamePage({
  game,
  moves,
  selectedId,
  motion,
  arrivalPieceId,
  busy,
  agentSession,
  agentActionBusy,
  movesError,
  resignArmed,
  onSquare,
  onUndo,
  onResign,
  onReopenAgent,
  onRestartAgent,
  onStopAgent,
  onRetryMoves,
  onRestart,
  onLeave,
  onHome,
}: {
  game: PublicGameState;
  moves: LegalMove[];
  selectedId: string | null;
  motion: BoardMotion | null;
  arrivalPieceId: string | null;
  busy: boolean;
  agentSession: AgentSessionState | null;
  agentActionBusy: boolean;
  movesError: string | null;
  resignArmed: boolean;
  onSquare: (position: Position) => void;
  onUndo: () => void;
  onResign: () => void;
  onReopenAgent: () => void;
  onRestartAgent: () => void;
  onStopAgent: () => void;
  onRetryMoves: () => void;
  onRestart: () => void;
  onLeave: () => void;
  onHome: () => void;
}) {
  const selected = game.board.find((piece) => piece.id === selectedId);
  const selectedMoves = selectedId
    ? moves.filter((move) => move.pieceId === selectedId)
    : [];
  const isAiTurn =
    game.matchType === "human-ai" && game.players.player2 === game.turn;
  const canResign =
    game.status.phase === "active" &&
    (game.matchType === "human-human" || game.players.player1 === game.turn);
  const resultKey = `${game.id}:${game.revision}`;
  const [reviewedResult, setReviewedResult] = useState<string | null>(null);
  const showResult =
    game.status.phase === "finished" && !motion && reviewedResult !== resultKey;

  return (
    <div className="game-page">
      <SiteHeader
        view="game"
        onHome={onHome}
        onBack={onLeave}
        routeLabel={game.status.phase === "finished" ? "棋局已结束" : undefined}
      />
      <main className="game-table">
        <aside
          className="game-sidebar game-sidebar--left"
          aria-label="对局信息与操作"
        >
          <div className="sidebar-title">
            <p className="eyebrow">
              {game.matchType === "human-ai" ? "人机对战" : "人人对战"}
            </p>
            <h1>{MODE_LABELS[game.mode]}</h1>
          </div>
          <AssignmentCard game={game} />
          <SeedCard seed={game.seed} />
          <StatusCard
            game={game}
            selected={selected}
            legalCount={selectedMoves.length}
            agentStatus={agentSession?.status}
          />
          {game.matchType === "human-ai" && (
            <AgentControllerCard
              session={agentSession}
              busy={agentActionBusy}
              onReopen={onReopenAgent}
              onRestart={onRestartAgent}
              onStop={onStopAgent}
            />
          )}
          <LastMove game={game} />

          <div className="game-actions">
            <button
              type="button"
              title={
                !game.allowUndo
                  ? "本局未开启悔棋"
                  : game.canUndo
                    ? game.matchType === "human-ai"
                      ? "回到你上次落子前"
                      : "撤回最近一步"
                    : "当前没有可撤回的着法"
              }
              disabled={busy || Boolean(motion) || !game.canUndo}
              onClick={onUndo}
            >
              悔棋
            </button>
            <button
              type="button"
              className={resignArmed ? "is-danger" : ""}
              disabled={busy || Boolean(motion) || !canResign}
              onClick={onResign}
            >
              {resignArmed
                ? `确认${COLOR_LABELS[game.turn]}认输`
                : isAiTurn
                  ? "模型回合中"
                  : "当前方认输"}
            </button>
            <button
              type="button"
              disabled={busy || Boolean(motion) || !game.seed}
              onClick={onRestart}
            >
              {game.seed ? "同 Seed 再来" : "终局后可同 Seed 再来"}
            </button>
            {game.status.phase === "finished" &&
              reviewedResult === resultKey && (
                <button type="button" onClick={() => setReviewedResult(null)}>
                  重新打开结算
                </button>
              )}
          </div>
        </aside>

        <div className="board-column">
          {game.matchType === "human-ai" &&
            (!agentSession ||
              ["paused", "exited", "stopped"].includes(
                agentSession.status,
              )) && (
              <div className="mobile-agent-recovery" role="alert">
                <strong>
                  {agentSession
                    ? `控制器${controllerStatusText[agentSession.status]}`
                    : "控制器状态不可用"}
                </strong>
                <span>
                  {agentSession?.error
                    ? `控制器错误：${agentSession.error}`
                    : "可尝试重新启动本地控制器。"}
                </span>
                <button
                  type="button"
                  disabled={agentActionBusy}
                  onClick={onRestartAgent}
                >
                  恢复控制器
                </button>
              </div>
            )}
          {movesError && game.status.phase === "active" && (
            <div className="legal-moves-error" role="alert">
              <span>{movesError}</span>
              <button type="button" onClick={onRetryMoves}>
                重试合法着法
              </button>
            </div>
          )}
          <Board
            game={game}
            legalMoves={selectedMoves}
            selectedId={selectedId}
            motion={motion}
            arrivalPieceId={arrivalPieceId}
            disabled={
              busy ||
              Boolean(motion) ||
              isAiTurn ||
              game.status.phase === "finished" ||
              Boolean(movesError)
            }
            onSquare={onSquare}
          />
        </div>

        <aside
          className="game-sidebar game-sidebar--right"
          aria-label="公开吃子区"
        >
          <div className="capture-title">
            <p className="eyebrow">公开战果</p>
            <h2>吃子区</h2>
            <p>暗子被吃时会在这里公开真实身份。</p>
          </div>
          <CapturedTray color="red" pieces={game.captured.red} game={game} />
          <CapturedTray
            color="black"
            pieces={game.captured.black}
            game={game}
          />
        </aside>
      </main>
      {showResult && (
        <GameResultDialog
          game={game}
          busy={busy}
          onRestart={onRestart}
          onReview={() => setReviewedResult(resultKey)}
          onLeave={onLeave}
          onHome={onHome}
        />
      )}
    </div>
  );
}

export function App({ api = gameApi }: { api?: GameApi }) {
  const [view, setView] = useState<AppView>("home");
  const [game, setGame] = useState<PublicGameState | null>(null);
  const [moves, setMoves] = useState<LegalMove[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resignArmed, setResignArmed] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiModelsResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [seedMode, setSeedMode] = useState<SeedMode>("random");
  const [customSeed, setCustomSeed] = useState("");
  const [agentSession, setAgentSession] = useState<AgentSessionState | null>(
    null,
  );
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const [boardMotion, setBoardMotion] = useState<BoardMotion | null>(null);
  const [arrivalPieceId, setArrivalPieceId] = useState<string | null>(null);
  const [movesError, setMovesError] = useState<string | null>(null);
  const [resumeGameId, setResumeGameId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LAST_GAME_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const gameRef = useRef<PublicGameState | null>(null);
  const arrivalTimerRef = useRef<number | null>(null);
  const legalRetryTimerRef = useRef<number | null>(null);
  const syncControllerRef = useRef<AbortController | null>(null);
  const agentControllerRef = useRef<AbortController | null>(null);
  const syncInFlightRef = useRef(false);
  const startInFlightRef = useRef(false);
  const responseSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(
    () => () => {
      if (arrivalTimerRef.current !== null) {
        window.clearTimeout(arrivalTimerRef.current);
      }
      if (legalRetryTimerRef.current !== null) {
        window.clearTimeout(legalRetryTimerRef.current);
      }
      syncControllerRef.current?.abort();
      agentControllerRef.current?.abort();
    },
    [],
  );

  const adoptGame = useCallback(
    async (nextGame: PublicGameState) => {
      syncControllerRef.current?.abort(
        new DOMException("开始采用更新的局面。", "AbortError"),
      );
      const controller = new AbortController();
      syncControllerRef.current = controller;
      syncInFlightRef.current = true;
      const sequence = ++responseSequenceRef.current;
      let nextMoves: LegalMove[] = [];
      let legalError: string | null = null;
      try {
        if (nextGame.status.phase === "active") {
          const response = await api.getLegalMoves(
            nextGame.id,
            undefined,
            controller.signal,
          );
          if (
            response.revision !== nextGame.revision ||
            response.turn !== nextGame.turn
          ) {
            throw new Error("合法着法与当前局面版本不一致，正在重新同步。");
          }
          nextMoves = response.moves;
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        legalError =
          caught instanceof Error
            ? `合法着法加载失败：${caught.message}`
            : "合法着法加载失败，正在重试。";
      } finally {
        if (syncControllerRef.current === controller) {
          syncControllerRef.current = null;
          syncInFlightRef.current = false;
        }
      }
      if (controller.signal.aborted || sequence < appliedSequenceRef.current) {
        return;
      }
      const current = gameRef.current;
      if (current?.id === nextGame.id && current.revision > nextGame.revision) {
        return;
      }
      appliedSequenceRef.current = sequence;
      setGame(nextGame);
      gameRef.current = nextGame;
      setSelectedId(null);
      setMoves(nextMoves);
      setMovesError(legalError);
      setResignArmed(false);
      try {
        window.localStorage.setItem(LAST_GAME_STORAGE_KEY, nextGame.id);
        setResumeGameId(nextGame.id);
      } catch {
        // Recovery is a convenience; private browsing may deny local storage.
      }
    },
    [api],
  );

  useEffect(() => {
    if (!movesError || !game || game.status.phase !== "active") return;
    if (legalRetryTimerRef.current !== null) {
      window.clearTimeout(legalRetryTimerRef.current);
    }
    legalRetryTimerRef.current = window.setTimeout(() => {
      legalRetryTimerRef.current = null;
      if (
        gameRef.current?.id === game.id &&
        gameRef.current.revision === game.revision
      ) {
        void adoptGame(game);
      }
    }, 1_000);
    return () => {
      if (legalRetryTimerRef.current !== null) {
        window.clearTimeout(legalRetryTimerRef.current);
        legalRetryTimerRef.current = null;
      }
    };
  }, [adoptGame, game, movesError]);

  const markArrival = useCallback((pieceId: string) => {
    if (arrivalTimerRef.current !== null) {
      window.clearTimeout(arrivalTimerRef.current);
    }
    setArrivalPieceId(pieceId);
    arrivalTimerRef.current = window.setTimeout(() => {
      setArrivalPieceId(null);
      arrivalTimerRef.current = null;
    }, 430);
  }, []);

  const transitionToGame = useCallback(
    async (
      nextGame: PublicGameState,
      previousGame: PublicGameState | null = gameRef.current,
    ) => {
      const nextMotion = previousGame
        ? deriveBoardMotion(previousGame, nextGame)
        : null;
      setSelectedId(null);
      setArrivalPieceId(null);

      if (!nextMotion || prefersReducedBoardMotion()) {
        setBoardMotion(null);
        await adoptGame(nextGame);
        if (nextMotion) markArrival(nextMotion.piece.id);
        return;
      }

      setBoardMotion(nextMotion);
      const animationFinished = new Promise<void>((resolve) => {
        window.setTimeout(resolve, nextMotion.durationMs);
      });
      await Promise.all([adoptGame(nextGame), animationFinished]);
      setBoardMotion(null);
      if (
        gameRef.current?.id === nextGame.id &&
        gameRef.current.revision === nextGame.revision
      ) {
        markArrival(nextMotion.piece.id);
      }
    },
    [adoptGame, markArrival],
  );

  const inspectAiModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const status = await api.getAiModels();
      setAiStatus(status);
      setSelectedModel((current) =>
        status.models.some(
          (model) =>
            model.name === current && model.supportsCompletion !== false,
        )
          ? current
          : (status.models.find((model) => model.supportsCompletion !== false)
              ?.name ?? ""),
      );
    } catch (caught) {
      setAiStatus({
        provider: "ollama",
        available: false,
        models: [],
        message:
          caught instanceof Error
            ? caught.message
            : "暂时无法检测本机模型服务。",
      });
      setSelectedModel("");
    } finally {
      setLoadingModels(false);
    }
  }, [api]);

  useEffect(() => {
    if (view === "mode" && aiStatus === null && !loadingModels) {
      void inspectAiModels();
    }
  }, [aiStatus, inspectAiModels, loadingModels, view]);

  const startGame = async (options: GameLaunchOptions) => {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    const request: CreateGameRequest = {
      mode: options.mode,
      allowDraw: options.allowDraw,
      allowUndo: options.allowUndo,
      matchType: options.matchType,
      ...(options.matchType === "human-ai" && options.model
        ? { aiModel: options.model }
        : {}),
      ...(options.seed ? { seed: options.seed } : {}),
    };
    const previousGame = gameRef.current;
    setBusy(true);
    setError(null);
    setAgentSession(null);
    setBoardMotion(null);
    setArrivalPieceId(null);
    try {
      if (previousGame?.matchType === "human-ai") {
        await api.stopAgentSession(previousGame.id).catch(() => undefined);
      }
      const nextGame = await api.createGame(request);
      if (options.seed) {
        setCustomSeed(options.seed.trim().normalize("NFC"));
      }
      await adoptGame(nextGame);
      setView("game");
      if (nextGame.matchType === "human-ai") {
        try {
          setAgentSession(await api.createAgentSession(nextGame.id));
        } catch (caught) {
          const timestamp = new Date().toISOString();
          const message =
            caught instanceof Error
              ? caught.message
              : "棋局已创建，但本地控制器启动失败。";
          setAgentSession({
            sessionId: "unavailable",
            gameId: nextGame.id,
            status: "exited",
            terminal: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastActivityAt: null,
            error: message,
            logPath: ".local/agent-logs",
          });
          setError(message);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "开局失败，请重试。");
    } finally {
      startInFlightRef.current = false;
      setBusy(false);
    }
  };

  const refresh = useCallback(
    async (quiet = false) => {
      const current = gameRef.current;
      if (!current || syncInFlightRef.current) return;
      const controller = new AbortController();
      syncControllerRef.current = controller;
      syncInFlightRef.current = true;
      try {
        const nextGame = await api.getGame(current.id, controller.signal);
        if (controller.signal.aborted || gameRef.current?.id !== current.id)
          return;
        if (nextGame.revision > current.revision) {
          if (syncControllerRef.current === controller) {
            syncControllerRef.current = null;
            syncInFlightRef.current = false;
          }
          await transitionToGame(nextGame, current);
        } else if (nextGame.revision === current.revision && movesError) {
          if (syncControllerRef.current === controller) {
            syncControllerRef.current = null;
            syncInFlightRef.current = false;
          }
          await adoptGame(nextGame);
        }
      } catch (caught) {
        if (!controller.signal.aborted && !quiet) {
          setError(caught instanceof Error ? caught.message : "同步局面失败。");
        }
      } finally {
        if (syncControllerRef.current === controller) {
          syncControllerRef.current = null;
          syncInFlightRef.current = false;
        }
      }
    },
    [adoptGame, api, movesError, transitionToGame],
  );

  const refreshAgentSession = useCallback(
    async (quiet = false) => {
      const current = gameRef.current;
      if (
        !current ||
        current.matchType !== "human-ai" ||
        agentControllerRef.current
      )
        return;
      const controller = new AbortController();
      agentControllerRef.current = controller;
      try {
        const state = await api.getAgentSession(current.id, controller.signal);
        if (!controller.signal.aborted && gameRef.current?.id === current.id) {
          setAgentSession(state);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          const message =
            caught instanceof Error ? caught.message : "同步控制器状态失败。";
          setAgentSession((previous) =>
            previous
              ? {
                  ...previous,
                  status: "exited",
                  error: `控制器状态同步失败：${message}`,
                  updatedAt: new Date().toISOString(),
                }
              : previous,
          );
          if (!quiet) {
            setError(message);
          }
        }
      } finally {
        if (agentControllerRef.current === controller) {
          agentControllerRef.current = null;
        }
      }
    },
    [api],
  );

  const activeGameId = game?.id;
  const activeGameUsesAgent = game?.matchType === "human-ai";

  useEffect(() => {
    if (view !== "game" || !activeGameId) return;
    const timer = window.setInterval(() => {
      void refresh(true);
      if (activeGameUsesAgent) void refreshAgentSession(true);
    }, 1_000);
    return () => {
      window.clearInterval(timer);
      syncControllerRef.current?.abort();
      syncControllerRef.current = null;
      syncInFlightRef.current = false;
      agentControllerRef.current?.abort();
      agentControllerRef.current = null;
    };
  }, [activeGameId, activeGameUsesAgent, refresh, refreshAgentSession, view]);

  const isAiTurn =
    game?.matchType === "human-ai" && game.players.player2 === game.turn;

  const selected = game?.board.find((piece) => piece.id === selectedId);
  const selectedMoves = selectedId
    ? moves.filter((move) => move.pieceId === selectedId)
    : [];

  const handleSquare = async (position: Position) => {
    if (
      !game ||
      busy ||
      boardMotion ||
      isAiTurn ||
      game.status.phase === "finished"
    ) {
      return;
    }
    const target = game.board.find(
      (piece) =>
        piece.position.x === position.x && piece.position.y === position.y,
    );
    const chosenMove = selectedMoves.find(
      (move) => move.to.x === position.x && move.to.y === position.y,
    );

    if (selected && chosenMove) {
      setBusy(true);
      setError(null);
      try {
        const nextGame = await api.move(
          game.id,
          selected.position,
          chosenMove.to,
          game.revision,
        );
        await transitionToGame(nextGame, game);
      } catch (caught) {
        if (
          caught instanceof ApiClientError &&
          caught.code === "STALE_REVISION"
        ) {
          await refresh();
        }
        setError(
          caught instanceof Error ? caught.message : "落子失败，请重试。",
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    if (target?.controller === game.turn) {
      setSelectedId((current) => (current === target.id ? null : target.id));
    } else {
      setSelectedId(null);
    }
  };

  const handleResign = async () => {
    if (!game || game.status.phase === "finished" || busy || boardMotion)
      return;
    if (game.matchType === "human-ai" && game.players.player1 !== game.turn)
      return;
    if (!resignArmed) {
      setResignArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adoptGame(await api.resign(game.id, game.revision));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "认输失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!game || busy || boardMotion || !game.canUndo) return;
    setBusy(true);
    setError(null);
    setArrivalPieceId(null);
    try {
      await adoptGame(await api.undo(game.id, game.revision));
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.code === "STALE_REVISION"
      ) {
        await refresh();
      }
      setError(caught instanceof Error ? caught.message : "悔棋失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (gameRef.current?.status.phase !== "active") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const clearCurrentGame = (nextView: AppView) => {
    syncControllerRef.current?.abort();
    syncControllerRef.current = null;
    syncInFlightRef.current = false;
    agentControllerRef.current?.abort();
    agentControllerRef.current = null;
    gameRef.current = null;
    setGame(null);
    setMoves([]);
    setMovesError(null);
    setSelectedId(null);
    setBoardMotion(null);
    setArrivalPieceId(null);
    setAgentSession(null);
    try {
      window.localStorage.removeItem(LAST_GAME_STORAGE_KEY);
      setResumeGameId(null);
    } catch {
      // Ignore unavailable local storage.
    }
    setView(nextView);
  };

  const confirmActiveLeave = (current: PublicGameState | null): boolean =>
    !current ||
    current.status.phase !== "active" ||
    window.confirm("对局仍在进行。确认离开并停止本地控制器吗？");

  const leaveGame = () => {
    const current = gameRef.current;
    if (!confirmActiveLeave(current)) return;
    if (current?.matchType === "human-ai") {
      void api.stopAgentSession(current.id).catch(() => undefined);
    }
    clearCurrentGame("mode");
  };

  const goHome = () => {
    const current = gameRef.current;
    if (!confirmActiveLeave(current)) return;
    if (current?.matchType === "human-ai") {
      void api.stopAgentSession(current.id).catch(() => undefined);
    }
    clearCurrentGame("home");
  };

  const resumeLastGame = async () => {
    if (!resumeGameId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await api.getGame(resumeGameId);
      await adoptGame(restored);
      setView("game");
      if (restored.matchType === "human-ai") {
        try {
          setAgentSession(await api.getAgentSession(restored.id));
        } catch (caught) {
          const timestamp = new Date().toISOString();
          setAgentSession({
            sessionId: "unavailable",
            gameId: restored.id,
            status: "exited",
            terminal: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastActivityAt: null,
            error:
              caught instanceof Error
                ? `无法恢复控制器状态：${caught.message}`
                : "无法恢复控制器状态。",
            logPath: ".local/agent-logs",
          });
        }
      }
    } catch (caught) {
      try {
        window.localStorage.removeItem(LAST_GAME_STORAGE_KEY);
      } catch {
        // Ignore unavailable local storage.
      }
      setResumeGameId(null);
      setError(caught instanceof Error ? caught.message : "无法恢复上局。");
    } finally {
      setBusy(false);
    }
  };

  const restartAgent = async () => {
    const current = gameRef.current;
    if (!current || current.matchType !== "human-ai" || agentActionBusy) return;
    setAgentActionBusy(true);
    setError(null);
    try {
      setAgentSession(await api.restartAgentSession(current.id));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "重启本地控制器失败。",
      );
    } finally {
      setAgentActionBusy(false);
    }
  };

  const stopAgent = async () => {
    const current = gameRef.current;
    if (!current || current.matchType !== "human-ai" || agentActionBusy) return;
    setAgentActionBusy(true);
    setError(null);
    try {
      setAgentSession(await api.stopAgentSession(current.id));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "停止本地控制器失败。",
      );
    } finally {
      setAgentActionBusy(false);
    }
  };

  const restart = () => {
    if (!game || !game.seed || boardMotion) return;
    void startGame({
      matchType: game.matchType,
      mode: game.mode,
      allowDraw: game.allowDraw,
      allowUndo: game.allowUndo,
      seed: game.seed,
      ...(game.aiModel ? { model: game.aiModel } : {}),
    });
  };

  return (
    <div className="app-shell">
      {view === "home" && (
        <HomePage
          onStart={() => setView("mode")}
          onTutorial={() => setView("tutorial")}
          onResume={() => void resumeLastGame()}
          canResume={Boolean(resumeGameId)}
        />
      )}
      {view === "tutorial" && (
        <TutorialPage onHome={goHome} onStart={() => setView("mode")} />
      )}
      {view === "mode" && (
        <ModePage
          aiStatus={aiStatus}
          selectedModel={selectedModel}
          loadingModels={loadingModels}
          busy={busy}
          seedMode={seedMode}
          customSeed={customSeed}
          onSelectModel={setSelectedModel}
          onRefreshModels={() => void inspectAiModels()}
          onSeedMode={setSeedMode}
          onCustomSeed={setCustomSeed}
          onStart={(options) => void startGame(options)}
          onHome={goHome}
        />
      )}
      {view === "game" && game && (
        <GamePage
          game={game}
          moves={moves}
          selectedId={selectedId}
          motion={boardMotion}
          arrivalPieceId={arrivalPieceId}
          busy={busy}
          agentSession={agentSession}
          agentActionBusy={agentActionBusy}
          movesError={movesError}
          resignArmed={resignArmed}
          onSquare={(position) => void handleSquare(position)}
          onUndo={() => void handleUndo()}
          onResign={() => void handleResign()}
          onReopenAgent={() => void restartAgent()}
          onRestartAgent={() => void restartAgent()}
          onStopAgent={() => void stopAgent()}
          onRetryMoves={() => void (game && adoptGame(game))}
          onRestart={restart}
          onLeave={leaveGame}
          onHome={goHome}
        />
      )}

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}
      {(busy ||
        agentActionBusy ||
        agentSession?.status === "starting" ||
        agentSession?.status === "thinking" ||
        agentSession?.status === "submitting") && (
        <div className="busy-bar" aria-label="正在处理" />
      )}
    </div>
  );
}
