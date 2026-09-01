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
  MATCH_LABELS,
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
import {
  ApiClientError,
  gameApi,
  type GameApi,
  type NetworkStatusResponse,
} from "./api";
import {
  clearSeatRecord,
  createSeatRecord,
  isMySeatTurn,
  isOpponentOnline,
  isSeatRevoked,
  isWaitingForOpponent,
  joinUrlFor,
  latestSeatRecord,
  lanStateChanged,
  normalizeRoomCodeInput,
  readSeatRecord,
  ROOM_CODE_LENGTH,
  sameSeatCredential,
  seatColorFor,
  takeRoomCodeFromLocation,
  writeSeatRecord,
  type LanSeatRecord,
} from "./lan";
import {
  deriveBoardMotion,
  prefersReducedBoardMotion,
  type BoardMotion,
} from "./motion";

type AppView = "home" | "mode" | "tutorial" | "game";
type SeedMode = "random" | "custom";
type ForgetSeatResult = "forgotten" | "replaced" | "storage-failed";

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
const NETWORK_POLL_INTERVAL_MS = 150;
const NETWORK_SWITCH_TIMEOUT_MS = 5_000;
const NETWORK_RECONCILE_INTERVAL_MS = 1_000;
const NETWORK_STATUS_REFRESH_INTERVAL_MS = 5_000;

const initialRecoveryGameId = (): string | null => {
  // A one-time LAN seat is more important than a later bare game id left by an
  // older client: without the seat id there would be no normal path to release
  // or resume that room.
  const storedSeat = readSeatRecord();
  if (storedSeat) return storedSeat.gameId;
  try {
    return window.localStorage.getItem(LAST_GAME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

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

const playerFor = (
  game: PublicGameState,
  color: Color,
  seatColor: Color | null = null,
): string => {
  if (game.matchType === "lan-human") {
    if (seatColor) return color === seatColor ? "你" : "对手";
    // No seat yet (a spectator read, or before the join completes): fall back
    // to the room's own vocabulary rather than inventing a perspective.
    return game.lan && color === game.lan.host ? "房主" : "访客";
  }
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
  networkMode,
}: {
  view: AppView;
  onHome: () => void;
  onBack?: () => void;
  routeLabel?: string;
  networkMode?: NetworkStatusResponse["mode"];
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
        <div className={`local-note ${networkMode === "lan" ? "is-lan" : ""}`}>
          <span />
          {networkMode === "lan" ? "已开放局域网" : "仅在本机运行"}
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
  networkMode,
}: {
  onStart: () => void;
  onTutorial: () => void;
  onResume: () => void;
  canResume: boolean;
  networkMode?: NetworkStatusResponse["mode"];
}) {
  return (
    <div className="landing-page">
      <SiteHeader
        view="home"
        onHome={() => undefined}
        networkMode={networkMode}
      />
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
        <span>
          覆子 · 本地象棋盲棋
          {networkMode === "lan" ? " · 局域网对战已开启" : ""}
        </span>
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
              {MATCH_LABELS[matchType]} · 红黑随机分配 · 红方先行
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
                    : matchType === "lan-human"
                      ? "每次撤回最近完成的一步棋，需对方同意。"
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

function JoinRoomDialog({
  busy,
  initialCode,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  busy: boolean;
  initialCode: string;
  onCancel: () => void;
  onConfirm: (roomCode: string) => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState(initialCode);
  useModalFocus(dialogRef, inputRef, onCancel, busy, returnFocusRef);
  // Short submits are guaranteed misses and would burn a join-throttle slot.
  const ready = code.length === ROOM_CODE_LENGTH;

  return (
    <div
      className="setup-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className="setup-dialog join-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="加入局域网对局"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) onConfirm(code);
        }}
      >
        <header className="setup-dialog-header">
          <div>
            <p className="eyebrow">局域网对战</p>
            <h2>加入对局</h2>
          </div>
          <button
            type="button"
            className="setup-close"
            aria-label="关闭加入对局"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div className="setup-dialog-body">
          <label className="seed-input-label" htmlFor="join-room-code">
            房间码
            <input
              id="join-room-code"
              ref={inputRef}
              value={code}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 M65BCB"
              // Cap after normalization: a raw maxlength would truncate a
              // formatted paste such as ABC-234 before removing the dash.
              onChange={(event) =>
                setCode(normalizeRoomCodeInput(event.target.value))
              }
            />
          </label>
          <p className="join-hint">
            房间码由房主的设备显示。你需要和对方处在同一个 Wi-Fi 下。
          </p>
        </div>

        <div className="setup-dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !ready}
          >
            {busy ? "正在加入…" : "加入对局"}
          </button>
        </div>
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
  onJoin,
  network,
  onToggleLan,
  joinPrefill,
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
  onJoin: (roomCode: string) => void;
  network: NetworkStatusResponse | null;
  onToggleLan: (enabled: boolean) => void;
  joinPrefill: string | null;
}) {
  const [pendingMatch, setPendingMatch] = useState<MatchType | null>(null);
  const [joining, setJoining] = useState(Boolean(joinPrefill));
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
  const remoteViewer = network?.local === false;

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
              disabled={busy || remoteViewer}
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
              disabled={busy || remoteViewer || loadingModels || !canStartAi}
              onClick={(event) => {
                setupTriggerRef.current = event.currentTarget;
                setPendingMatch("human-ai");
              }}
            >
              {canStartAi ? "选择人机对战" : "等待本机模型"}
              <span aria-hidden="true">→</span>
            </button>
          </article>

          <article className="mode-card mode-card--lan">
            <div className="mode-number">03</div>
            <div className="mode-icon mode-icon--lan" aria-hidden="true">
              <i />
              <i />
            </div>
            <p className="mode-kicker">同一 Wi-Fi 下的两台设备</p>
            <h2>局域网对战</h2>
            <p>
              各用各的手机、平板或电脑，各自只看到自己的一方。开局后把房间码给对方即可。
            </p>
            <ul>
              <li>建房后生成 6 位房间码</li>
              <li>悔棋需对方同意</li>
              <li>对手掉线可重新邀请</li>
            </ul>

            <div className="lan-switch-row">
              <div className="lan-switch-label">
                <h3 id="lan-mode-title">允许同一网络的设备连接</h3>
              </div>
              <button
                type="button"
                className={`switch-control ${network?.mode === "lan" ? "is-on" : ""}`}
                role="switch"
                aria-checked={network?.mode === "lan"}
                aria-labelledby="lan-mode-title"
                disabled={busy || !network?.local || network.pending}
                onClick={() => onToggleLan(network?.mode !== "lan")}
              >
                <span />
              </button>
            </div>
            <div className="lan-switch-note">
              {/* Stated where the decision is made, not buried in docs. */}
              <small>
                {!network?.local
                  ? "你正在从其他设备访问，只有运行服务的那台机器可以切换。"
                  : network.pending
                    ? `正在切换到${network.targetMode === "lan" ? "局域网" : "仅本机"}监听…`
                    : !network.listening
                      ? "服务当前没有可用的网络监听。"
                      : network.mode === "lan"
                        ? network.addresses.length
                          ? `其他设备可通过 ${network.addresses.length} 个候选地址访问。`
                          : "已开启，但没有检测到可用的局域网地址。"
                        : "关闭时服务只监听本机，别人扫不到。请只在可信的家庭网络下开启。"}
              </small>
              {network?.error && <small role="alert">{network.error}</small>}
            </div>

            <div className="lan-actions">
              <button
                type="button"
                className="primary-button mode-start"
                disabled={busy || remoteViewer}
                onClick={(event) => {
                  setupTriggerRef.current = event.currentTarget;
                  setPendingMatch("lan-human");
                }}
              >
                创建房间 <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="lan-join-open"
                disabled={busy}
                onClick={(event) => {
                  setupTriggerRef.current = event.currentTarget;
                  setJoining(true);
                }}
              >
                我有房间码，加入对局
              </button>
            </div>
          </article>
        </div>
      </main>

      {joining && (
        <JoinRoomDialog
          busy={busy}
          initialCode={joinPrefill ?? ""}
          onCancel={() => setJoining(false)}
          onConfirm={(code) => {
            setJoining(false);
            onJoin(code);
          }}
          returnFocusRef={setupTriggerRef}
        />
      )}

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
  /**
   * Which colour sits at the bottom. Omitted for same-screen and human-AI, so
   * those keep deriving the orientation from `players.player1` exactly as
   * before; LAN passes the device's own seat so each player faces their side.
   */
  bottomSide?: Color;
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
  bottomSide,
  onSquare,
}: BoardProps) {
  const flipped = (bottomSide ?? game.players.player1) === "black";
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
        <strong>{playerFor(game, topColor, bottomSide ?? null)}</strong>
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
        <strong>{playerFor(game, bottomColor, bottomSide ?? null)}</strong>
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
  seatColor = null,
}: {
  color: Color;
  seatColor?: Color | null;
  pieces: PublicCapturedPiece[];
  game: PublicGameState;
}) {
  return (
    <section className={`captured-tray captured-tray--${color}`}>
      <div className="captured-heading">
        <div>
          <span className={`side-dot side-dot--${color}`} />
          <strong>{playerFor(game, color, seatColor)}</strong>
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
  seatColor = null,
}: {
  game: PublicGameState;
  selected?: PublicBoardPiece;
  legalCount: number;
  agentStatus?: AgentSessionState["status"];
  seatColor?: Color | null;
}) {
  const finished = game.status.phase === "finished";
  const currentPlayer = playerFor(game, game.turn, seatColor);

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

function AssignmentCard({
  game,
  seatColor = null,
}: {
  game: PublicGameState;
  seatColor?: Color | null;
}) {
  return (
    <section className="game-card assignment-card">
      <div className="card-heading-row">
        <p className="card-label">本局执方</p>
      </div>
      <div className="assignment-row">
        <span className="side-dot side-dot--red" />
        <strong>红方</strong>
        <span>{playerFor(game, "red", seatColor)}</span>
        <small>先行</small>
      </div>
      <div className="assignment-row">
        <span className="side-dot side-dot--black" />
        <strong>黑方</strong>
        <span>{playerFor(game, "black", seatColor)}</span>
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

/**
 * Host-only. Shows the invite the guest needs, plus the opponent's live
 * presence so the host knows when a re-invite is warranted.
 */
function LanRoomCard({
  game,
  seatColor,
  roomCode,
  addresses,
  port,
  busy,
  onReinvite,
}: {
  game: PublicGameState;
  seatColor: Color | null;
  roomCode: string | null;
  addresses: string[];
  port: number;
  busy: boolean;
  onReinvite: () => void;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    setCopiedValue(null);
    setCopyFailed(false);
  }, [roomCode, addresses]);

  const isHost = Boolean(game.lan && seatColor === game.lan.host);
  const finished = game.status.phase === "finished";
  const waiting = isWaitingForOpponent(game);
  const opponentOnline = isOpponentOnline(game, seatColor);
  // Always an IP literal from the server: LAN mode refuses DNS names, so a
  // link built from window.location could point somewhere the server rejects.
  const joinLinks = roomCode
    ? addresses.map((address) => ({
        address,
        url: joinUrlFor(address, port, roomCode),
      }))
    : [];

  const handleCopy = async (value: string) => {
    try {
      await copyText(value);
      setCopiedValue(value);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <section className="game-card lan-room-card">
      <div className="card-heading-row">
        <p className="card-label">局域网房间</p>
        <span
          className={`lan-presence lan-presence--${
            finished
              ? "offline"
              : waiting
                ? "waiting"
                : opponentOnline
                  ? "online"
                  : "offline"
          }`}
          role="status"
        >
          {finished
            ? "房间已结束"
            : waiting
              ? "等待对手加入"
              : opponentOnline
                ? "对手在线"
                : "对手已断线"}
        </span>
      </div>

      {isHost && roomCode ? (
        <>
          <div className="lan-code-row">
            <code data-testid="lan-room-code">{roomCode}</code>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCopy(roomCode)}
            >
              {copiedValue === roomCode ? "已复制" : "复制房间码"}
            </button>
          </div>
          {joinLinks.length ? (
            <div className="lan-join-url">
              <p>请选择与对手处在同一网段的地址：</p>
              <ul className="lan-join-links">
                {joinLinks.map(({ address, url }) => (
                  <li key={address}>
                    <code>{url}</code>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`复制 ${address} 邀请链接`}
                      onClick={() => void handleCopy(url)}
                    >
                      {copiedValue === url ? "已复制" : "复制链接"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="lan-join-url lan-join-url--off">
              未开启局域网监听时，对方无法从其他设备连接。
            </p>
          )}
          {!finished && !waiting && !opponentOnline && (
            <button
              type="button"
              className="lan-reinvite"
              disabled={busy}
              onClick={onReinvite}
            >
              重新邀请（作废旧房间码）
            </button>
          )}
        </>
      ) : (
        <p className="lan-join-url">
          你以{seatColor ? COLOR_LABELS[seatColor] : "访客"}身份加入了这一局。
        </p>
      )}
      {copyFailed && <small role="alert">复制失败，请手动选中后复制。</small>}
    </section>
  );
}

/** Shown on the opponent's device while a takeback is awaiting an answer. */
function UndoRequestPrompt({
  game,
  seatColor,
  busy,
  onResolve,
}: {
  game: PublicGameState;
  seatColor: Color | null;
  busy: boolean;
  onResolve: (accept: boolean) => void;
}) {
  const request = game.lan?.undoRequest ?? null;
  if (!request || !seatColor) return null;
  const mine = request.requestedBy === seatColor;

  return (
    <section className="game-card lan-undo-prompt" role="alert">
      <p className="card-label">悔棋协商</p>
      {mine ? (
        <>
          <p>已向对手发出悔棋请求，等待回应。</p>
          <div className="lan-undo-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve(false)}
            >
              取消请求
            </button>
          </div>
        </>
      ) : (
        <>
          <p>对手请求撤回刚走的那一步。</p>
          {/* Consent is informed on purpose: an approved takeback re-hides the
              piece server-side, but the opponent has already seen it. */}
          <small>同意后局面回退，但你已经看到的暗子身份不会被忘记。</small>
          <div className="lan-undo-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => onResolve(true)}
            >
              同意悔棋
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve(false)}
            >
              拒绝
            </button>
          </div>
        </>
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
  seatColor = null,
}: {
  game: PublicGameState;
  busy: boolean;
  onRestart: () => void;
  onReview: () => void;
  onLeave: () => void;
  onHome: () => void;
  seatColor?: Color | null;
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
  const wonIt =
    winner !== null &&
    (game.matchType === "human-ai"
      ? game.players.player1 === winner
      : game.matchType === "lan-human" && seatColor === winner);
  const winnerCopy = winner
    ? wonIt
      ? "你拿下了这一局"
      : `${playerFor(game, winner, seatColor)} 执${COLOR_LABELS[winner]}获胜`
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
            onClick={game.matchType === "lan-human" ? onReview : onRestart}
          >
            {/* A LAN rematch needs a fresh room and a new invite, and
                `restart` would POST an unaccepted matchType. */}
            {game.matchType === "lan-human" ? "查看最终棋盘" : "同 Seed 再来"}
          </button>
          {game.matchType !== "lan-human" && (
            <button type="button" disabled={busy} onClick={onReview}>
              查看最终棋盘
            </button>
          )}
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
  seat,
  seatColor,
  network,
  onReinvite,
  onResolveUndo,
  onRejoin,
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
  seat: LanSeatRecord | null;
  seatColor: Color | null;
  network: NetworkStatusResponse | null;
  onReinvite: () => void;
  onResolveUndo: (accept: boolean) => void;
  onRejoin: () => void;
}) {
  const selected = game.board.find((piece) => piece.id === selectedId);
  const selectedMoves = selectedId
    ? moves.filter((move) => move.pieceId === selectedId)
    : [];
  const isAiTurn =
    game.matchType === "human-ai" && game.players.player2 === game.turn;
  const lan = game.matchType === "lan-human";
  const myTurn = isMySeatTurn(game, seatColor);
  const waitingForOpponent = lan && isWaitingForOpponent(game);
  const revoked = lan && isSeatRevoked(game, seat);
  const canResign =
    game.status.phase === "active" &&
    !revoked &&
    (lan
      ? // A LAN seat concedes its own side, so it must work on either turn —
        // otherwise the button would be dead half the time.
        seatColor !== null
      : game.matchType === "human-human" || game.players.player1 === game.turn);
  // A takeback rewinds the last ply, which belongs to whoever is not on turn.
  const canRequestUndo = lan
    ? !revoked &&
      seatColor !== null &&
      seatColor !== game.turn &&
      !waitingForOpponent &&
      // The negotiation only exists while the game is running; a request made
      // after the result would be dropped by the next projection.
      game.status.phase === "active" &&
      !game.lan?.undoRequest
    : true;
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
            <p className="eyebrow">{MATCH_LABELS[game.matchType]}</p>
            <h1>{MODE_LABELS[game.mode]}</h1>
          </div>
          <AssignmentCard game={game} seatColor={seatColor} />
          {lan && (
            <LanRoomCard
              game={game}
              seatColor={seatColor}
              roomCode={game.lan?.roomCode ?? null}
              addresses={network?.addresses ?? []}
              port={network?.port ?? 3001}
              busy={busy}
              onReinvite={onReinvite}
            />
          )}
          {lan && !revoked && game.lan?.undoRequest && (
            <UndoRequestPrompt
              game={game}
              seatColor={seatColor}
              busy={busy}
              onResolve={onResolveUndo}
            />
          )}
          <SeedCard seed={game.seed} />
          <StatusCard
            seatColor={seatColor}
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
                  : lan && waitingForOpponent
                    ? "等待对手加入后才能请求悔棋"
                    : game.canUndo
                      ? game.matchType === "human-ai"
                        ? "回到你上次落子前"
                        : game.matchType === "lan-human"
                          ? "向对手请求撤回你刚走的那一步"
                          : "撤回最近一步"
                      : "当前没有可撤回的着法"
              }
              disabled={
                busy || Boolean(motion) || !game.canUndo || !canRequestUndo
              }
              onClick={onUndo}
            >
              {lan ? "请求悔棋" : "悔棋"}
            </button>
            <button
              type="button"
              className={resignArmed ? "is-danger" : ""}
              disabled={busy || Boolean(motion) || !canResign}
              onClick={onResign}
            >
              {resignArmed
                ? `确认${COLOR_LABELS[lan && seatColor ? seatColor : game.turn]}认输`
                : isAiTurn
                  ? "模型回合中"
                  : lan
                    ? "认输"
                    : "当前方认输"}
            </button>
            {!lan && (
              <button
                type="button"
                disabled={busy || Boolean(motion) || !game.seed}
                onClick={onRestart}
              >
                {game.seed ? "同 Seed 再来" : "终局后可同 Seed 再来"}
              </button>
            )}
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
          {lan &&
            game.status.phase === "active" &&
            (waitingForOpponent || revoked) && (
              <div className="lan-block" role="alert">
                {revoked ? (
                  <>
                    <strong>你已被移出对局</strong>
                    <span>房主重新生成了房间码，请用新的房间码重新加入。</span>
                    <button type="button" disabled={busy} onClick={onRejoin}>
                      重新加入
                    </button>
                  </>
                ) : (
                  <>
                    <strong>等待对手加入</strong>
                    <span>把房间码发给对方，对方加入后即可开始。</span>
                  </>
                )}
              </div>
            )}
          <Board
            game={game}
            legalMoves={selectedMoves}
            selectedId={selectedId}
            motion={motion}
            arrivalPieceId={arrivalPieceId}
            bottomSide={lan ? (seatColor ?? undefined) : undefined}
            disabled={
              busy ||
              Boolean(motion) ||
              isAiTurn ||
              !myTurn ||
              waitingForOpponent ||
              revoked ||
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
          <CapturedTray
            color="red"
            pieces={game.captured.red}
            game={game}
            seatColor={seatColor}
          />
          <CapturedTray
            color="black"
            pieces={game.captured.black}
            game={game}
            seatColor={seatColor}
          />
        </aside>
      </main>
      {showResult && (
        <GameResultDialog
          game={game}
          busy={busy}
          seatColor={seatColor}
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
  const [resumeGameId, setResumeGameId] = useState<string | null>(
    initialRecoveryGameId,
  );
  const [seat, setSeat] = useState<LanSeatRecord | null>(() =>
    readSeatRecord(),
  );
  const [network, setNetwork] = useState<NetworkStatusResponse | null>(null);
  // Read once at mount and stripped from the URL immediately, so a shared
  // invite link does not linger in history or a referrer.
  const [joinPrefill, setJoinPrefill] = useState<string | null>(() =>
    takeRoomCodeFromLocation(),
  );
  const gameRef = useRef<PublicGameState | null>(null);
  const seatRef = useRef<LanSeatRecord | null>(seat);
  const arrivalTimerRef = useRef<number | null>(null);
  const legalRetryTimerRef = useRef<number | null>(null);
  const syncControllerRef = useRef<AbortController | null>(null);
  const agentControllerRef = useRef<AbortController | null>(null);
  const networkRefreshControllerRef = useRef<AbortController | null>(null);
  const networkTransitionRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const startInFlightRef = useRef(false);
  const responseSequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    seatRef.current = seat;
  }, [seat]);

  const seatColor = seatColorFor(game, seat);
  /** The token this device should present, if it holds this game's seat. */
  const seatTokenFor = useCallback((gameId: string): string | undefined => {
    const record = seatRef.current;
    return record && record.gameId === gameId ? record.token : undefined;
  }, []);

  const rememberRecoverySeat = useCallback((record: LanSeatRecord) => {
    seatRef.current = record;
    setSeat(record);
    setResumeGameId(record.gameId);
  }, []);

  /**
   * Clears one specific credential. If another tab replaced it while an API
   * call was in flight, adopt that newer record instead and ask the caller to
   * reconcile it before starting another game.
   */
  const forgetSeat = useCallback(
    (expected: LanSeatRecord | null = seatRef.current): ForgetSeatResult => {
      const memory = seatRef.current;
      if (expected && memory && !sameSeatCredential(memory, expected)) {
        return "replaced";
      }
      const discardedGameId = expected?.gameId ?? memory?.gameId;
      const cleared = clearSeatRecord(expected ?? undefined);
      const replacement = readSeatRecord();
      if (
        expected &&
        replacement &&
        !sameSeatCredential(replacement, expected)
      ) {
        rememberRecoverySeat(replacement);
        return "replaced";
      }
      if (
        expected &&
        seatRef.current &&
        !sameSeatCredential(seatRef.current, expected)
      ) {
        return "replaced";
      }
      if (!cleared) return "storage-failed";
      setSeat(null);
      seatRef.current = null;
      setResumeGameId((current) => {
        if (discardedGameId && current !== discardedGameId) return current;
        try {
          const stored = window.localStorage.getItem(LAST_GAME_STORAGE_KEY);
          if (!discardedGameId || stored === discardedGameId) {
            window.localStorage.removeItem(LAST_GAME_STORAGE_KEY);
          }
        } catch {
          // In-memory recovery state still needs to reflect the discarded seat.
        }
        return null;
      });
      return "forgotten";
    },
    [rememberRecoverySeat],
  );

  /**
   * There is room for one recoverable seat in this browser. Before starting a
   * different game, explicitly end a still-active stored room; a transient
   * read/write failure leaves the credential untouched and aborts replacement.
   * Re-read storage on every pass because another tab may have issued a newer
   * one-time seat while this tab was waiting for the network.
   */
  const releaseRecoverableSeat = useCallback(async (): Promise<boolean> => {
    while (true) {
      const record = latestSeatRecord(seatRef.current, readSeatRecord());
      if (!record) return true;
      const finishRecovery = (): "retry" | "complete" | "failed" => {
        const result = forgetSeat(record);
        if (result === "replaced") return "retry";
        if (result === "storage-failed") {
          setError(
            "浏览器无法安全更新局域网座位记录，请释放站点存储空间后重试。",
          );
          return "failed";
        }
        return "complete";
      };
      const alreadyHeldInThisTab = Boolean(
        seatRef.current && sameSeatCredential(seatRef.current, record),
      );
      if (!seatRef.current || !sameSeatCredential(seatRef.current, record)) {
        rememberRecoverySeat(record);
      }

      let storedGame =
        alreadyHeldInThisTab && gameRef.current?.id === record.gameId
          ? gameRef.current
          : null;
      if (!storedGame) {
        try {
          storedGame = await api.getGame(
            record.gameId,
            undefined,
            record.token,
          );
        } catch (caught) {
          if (
            caught instanceof ApiClientError &&
            caught.code === "GAME_NOT_FOUND"
          ) {
            const result = finishRecovery();
            if (result === "retry") continue;
            return result === "complete";
          }
          setError(
            caught instanceof Error
              ? `无法确认待恢复的局域网对局：${caught.message}`
              : "无法确认待恢复的局域网对局，请稍后重试。",
          );
          return false;
        }
      }

      const validLanSeat =
        storedGame.matchType === "lan-human" &&
        seatColorFor(storedGame, record) !== null &&
        !isSeatRevoked(storedGame, record);
      if (storedGame.status.phase === "finished" || !validLanSeat) {
        const result = finishRecovery();
        if (result === "retry") continue;
        return result === "complete";
      }
      if (
        !window.confirm(
          "你还有一局可恢复的局域网对局。开始新局将视为认输并结束旧房间，是否继续？",
        )
      ) {
        return false;
      }

      try {
        await api.resign(storedGame.id, storedGame.revision, record.token);
        const result = finishRecovery();
        if (result === "retry") continue;
        return result === "complete";
      } catch (caught) {
        setError(
          caught instanceof Error
            ? `结束待恢复对局失败：${caught.message}`
            : "结束待恢复对局失败，请稍后重试。",
        );
        return false;
      }
    }
  }, [api, forgetSeat, rememberRecoverySeat]);

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
      networkRefreshControllerRef.current?.abort();
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
    if (options.matchType === "lan-human") return;
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
      if (!(await releaseRecoverableSeat())) return;
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
        // Sending the seat token doubles as this device's presence heartbeat,
        // so the opponent's online indicator costs no extra request.
        const nextGame = await api.getGame(
          current.id,
          controller.signal,
          seatTokenFor(current.id),
        );
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
        } else if (
          nextGame.revision === current.revision &&
          lanStateChanged(current, nextGame) &&
          gameRef.current?.revision === current.revision
        ) {
          // A guest joining, going offline, or answering a takeback does not
          // move a piece, so `revision` never changes and the branches above
          // never fire. Without this the host would sit on 「等待对手加入」
          // forever while the guest was already playing.
          //
          // setGame, NOT adoptGame: adoptGame refetches legal moves and clears
          // the selection, which would wipe the piece you are holding roughly
          // once a second.
          setGame(nextGame);
          gameRef.current = nextGame;
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
    [adoptGame, api, movesError, seatTokenFor, transitionToGame],
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

  /** Adopts a freshly claimed seat and its game in one step. */
  const adoptSeat = useCallback(
    async (
      nextGame: PublicGameState,
      record: Omit<LanSeatRecord, "savedAt" | "storageId" | "generation">,
    ) => {
      // The freshly issued credential is authoritative in memory. Storage is
      // only best-effort refresh recovery and may be unavailable or full.
      const claimed = createSeatRecord(record);
      setSeat(claimed);
      seatRef.current = claimed;
      writeSeatRecord(claimed);
      await adoptGame(nextGame);
      setView("game");
    },
    [adoptGame],
  );

  const startLanGame = async (options: GameLaunchOptions) => {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setAgentSession(null);
    setBoardMotion(null);
    setArrivalPieceId(null);
    try {
      if (!(await releaseRecoverableSeat())) return;
      const created = await api.createRoom({
        mode: options.mode,
        allowDraw: options.allowDraw,
        allowUndo: options.allowUndo,
        ...(options.seed ? { seed: options.seed } : {}),
      });
      if (options.seed) setCustomSeed(options.seed.trim().normalize("NFC"));
      await adoptSeat(created.game, {
        gameId: created.game.id,
        color: created.seat.color,
        token: created.seat.token,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "建房失败，请重试。");
    } finally {
      startInFlightRef.current = false;
      setBusy(false);
    }
  };

  const joinLanGame = async (roomCode: string) => {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setAgentSession(null);
    setBoardMotion(null);
    setArrivalPieceId(null);
    try {
      if (!(await releaseRecoverableSeat())) return;
      const joined = await api.joinRoom(normalizeRoomCodeInput(roomCode));
      setJoinPrefill(null);
      await adoptSeat(joined.game, {
        gameId: joined.game.id,
        color: joined.seat.color,
        token: joined.seat.token,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加入失败，请重试。");
    } finally {
      startInFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleReinvite = async () => {
    const current = gameRef.current;
    const token = current ? seatTokenFor(current.id) : undefined;
    const roomCode = current?.lan?.roomCode;
    if (
      !current ||
      !token ||
      !roomCode ||
      busy ||
      isSeatRevoked(current, seatRef.current)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.reinvite(
        current.id,
        current.revision,
        roomCode,
        token,
      );
      setGame(result.game);
      gameRef.current = result.game;
      // The code itself comes back through `game.lan.roomCode` on every read,
      // so only the seat needs persisting.
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "重新邀请失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleResolveUndo = async (accept: boolean) => {
    const current = gameRef.current;
    const token = current ? seatTokenFor(current.id) : undefined;
    const requestId = current?.lan?.undoRequest?.id;
    if (
      !current ||
      !token ||
      !requestId ||
      busy ||
      isSeatRevoked(current, seatRef.current)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.resolveUndo(
        current.id,
        current.revision,
        requestId,
        accept,
        token,
      );
      // Approval rewinds the position, so re-adopt; a decline only clears
      // the prompt and must not disturb the board.
      if (next.revision > current.revision)
        await transitionToGame(next, current);
      else {
        setGame(next);
        gameRef.current = next;
      }
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.code === "STALE_REVISION"
      ) {
        await refresh();
      }
      setError(caught instanceof Error ? caught.message : "处理悔棋失败。");
    } finally {
      setBusy(false);
    }
  };

  const refreshNetwork = useCallback(async () => {
    if (networkTransitionRef.current) return;
    networkRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    networkRefreshControllerRef.current = controller;
    try {
      const status = await api.getNetwork(controller.signal);
      if (!controller.signal.aborted && !networkTransitionRef.current) {
        setNetwork(status);
      }
    } catch {
      // The toggle simply stays unavailable; nothing else depends on it.
    } finally {
      if (networkRefreshControllerRef.current === controller) {
        networkRefreshControllerRef.current = null;
      }
    }
  }, [api]);

  useEffect(() => {
    void refreshNetwork();
    const timer = window.setInterval(
      () => void refreshNetwork(),
      NETWORK_STATUS_REFRESH_INTERVAL_MS,
    );
    const handleFocus = () => void refreshNetwork();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      networkRefreshControllerRef.current?.abort();
      networkRefreshControllerRef.current = null;
    };
  }, [refreshNetwork]);

  // A five-second foreground confirmation timeout is a UX boundary, not a
  // reason to abandon the controller. Once the button is released, continue
  // reconciling a pending transition until the server reports a terminal
  // state, so a long FIFO never requires a page reload.
  useEffect(() => {
    if (busy || !network?.pending) return;
    let cancelled = false;
    let timer: number | null = null;

    function schedule() {
      timer = window.setTimeout(
        () => void reconcile(),
        NETWORK_RECONCILE_INTERVAL_MS,
      );
    }
    async function reconcile() {
      try {
        const status = await api.getNetwork();
        if (cancelled) return;
        setNetwork(status);
        if (status.pending) {
          schedule();
        } else if (status.error) {
          setError(status.error);
        } else if (!status.listening) {
          setError("监听切换失败，服务当前没有可用端口。");
        } else {
          setError((current) =>
            current === "监听切换确认超时，请检查服务状态后重试。"
              ? null
              : current,
          );
        }
      } catch {
        if (!cancelled) schedule();
      }
    }

    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, busy, network?.pending]);

  // Arriving through a shared invite link jumps straight to the join step.
  useEffect(() => {
    if (joinPrefill) setView("mode");
  }, [joinPrefill]);

  const handleToggleLan = async (enabled: boolean) => {
    networkTransitionRef.current = true;
    networkRefreshControllerRef.current?.abort();
    networkRefreshControllerRef.current = null;
    setBusy(true);
    setError(null);
    const targetMode = enabled ? "lan" : "loopback";
    try {
      let status = await api.setNetworkMode(targetMode);
      setNetwork(status);
      const deadline = Date.now() + NETWORK_SWITCH_TIMEOUT_MS;

      while (
        status.pending ||
        status.mode !== targetMode ||
        !status.listening
      ) {
        if (!status.pending && status.error) throw new Error(status.error);
        if (!status.pending && !status.listening) {
          throw new Error("监听切换失败，服务当前没有可用端口。");
        }
        if (Date.now() >= deadline) {
          throw new Error("监听切换确认超时，请检查服务状态后重试。");
        }

        await wait(NETWORK_POLL_INTERVAL_MS);
        try {
          status = await api.getNetwork();
          setNetwork(status);
        } catch {
          // Closing the old listener can briefly break the poll. Retry until
          // the five-second deadline instead of treating that gap as failure.
        }
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "切换局域网监听失败。",
      );
    } finally {
      networkTransitionRef.current = false;
      setBusy(false);
    }
  };

  const handleSquare = async (position: Position) => {
    if (
      !game ||
      busy ||
      boardMotion ||
      isAiTurn ||
      !isMySeatTurn(game, seatColor) ||
      isSeatRevoked(game, seatRef.current) ||
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
          seatTokenFor(game.id),
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
    // A LAN player may concede at any time, but only from their own seat.
    if (
      game.matchType === "lan-human" &&
      (!seatColor || isSeatRevoked(game, seatRef.current))
    )
      return;
    if (!resignArmed) {
      setResignArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adoptGame(
        await api.resign(game.id, game.revision, seatTokenFor(game.id)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "认输失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!game || busy || boardMotion || !game.canUndo) return;
    if (game.matchType === "lan-human" && isSeatRevoked(game, seatRef.current))
      return;
    setBusy(true);
    setError(null);
    setArrivalPieceId(null);
    try {
      if (game.matchType === "lan-human") {
        // Only asks; the opponent's approval is what actually rewinds.
        const token = seatTokenFor(game.id);
        if (!token) throw new Error("尚未持有本局座位。");
        const requested = await api.requestUndo(game.id, game.revision, token);
        setGame(requested);
        // gameRef is only re-synced by a post-commit effect, so the 1s poll
        // would otherwise diff against a stale snapshot for one tick.
        gameRef.current = requested;
        return;
      }
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

  const clearCurrentGame = (
    nextView: AppView,
    { clearSeat = false }: { clearSeat?: boolean } = {},
  ) => {
    const preservedSeat = clearSeat
      ? forgetSeat() === "forgotten"
        ? null
        : seatRef.current
      : seatRef.current;
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
      if (preservedSeat) {
        window.localStorage.setItem(
          LAST_GAME_STORAGE_KEY,
          preservedSeat.gameId,
        );
      } else {
        window.localStorage.removeItem(LAST_GAME_STORAGE_KEY);
      }
    } catch {
      // Ignore unavailable local storage.
    }
    setResumeGameId(preservedSeat?.gameId ?? null);
    setView(nextView);
  };

  const confirmActiveLeave = (current: PublicGameState | null): boolean => {
    if (!current || current.status.phase !== "active") return true;
    const activeLanSeat =
      current.matchType === "lan-human" &&
      Boolean(seatTokenFor(current.id)) &&
      !isSeatRevoked(current, seatRef.current);
    return window.confirm(
      activeLanSeat
        ? "对局仍在进行。离开将视为认输并结束本局，是否继续？"
        : "对局仍在进行。确认离开并停止本地控制器吗？",
    );
  };

  const departGame = async (nextView: AppView) => {
    const current = gameRef.current;
    const currentSeat = seatRef.current;
    const ownsCurrentSeat = Boolean(
      current?.matchType === "lan-human" &&
      currentSeat &&
      currentSeat.gameId === current.id,
    );
    if (!confirmActiveLeave(current)) return;
    if (
      current?.matchType === "lan-human" &&
      current.status.phase === "active" &&
      !isSeatRevoked(current, seatRef.current)
    ) {
      const token = seatTokenFor(current.id);
      if (token) {
        setBusy(true);
        setError(null);
        try {
          // Do not erase the one-time seat while its room is still live. A
          // confirmed departure first ends the game; on failure the seat and
          // resume state remain available so the host cannot be stranded.
          await api.resign(current.id, current.revision, token);
        } catch (caught) {
          if (
            caught instanceof ApiClientError &&
            caught.code === "STALE_REVISION"
          ) {
            await refresh();
          }
          setError(
            caught instanceof Error
              ? `离开对局失败：${caught.message}`
              : "离开对局失败，请重试。",
          );
          return;
        } finally {
          setBusy(false);
        }
      }
    }
    if (current?.matchType === "human-ai") {
      void api.stopAgentSession(current.id).catch(() => undefined);
    }
    clearCurrentGame(nextView, { clearSeat: ownsCurrentSeat });
  };

  const leaveGame = () => void departGame("mode");

  const goHome = () => void departGame("home");

  const resumeLastGame = async () => {
    if (!resumeGameId || busy) return;
    const requestedGameId = resumeGameId;
    setBusy(true);
    setError(null);
    try {
      const restoredSeat =
        seatRef.current?.gameId === requestedGameId
          ? seatRef.current
          : readSeatRecord(requestedGameId);
      const restored = await api.getGame(
        requestedGameId,
        undefined,
        restoredSeat?.token,
      );
      if (restoredSeat && seatRef.current?.gameId !== restoredSeat.gameId) {
        setSeat(restoredSeat);
        seatRef.current = restoredSeat;
      }
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
      if (
        caught instanceof ApiClientError &&
        caught.code === "GAME_NOT_FOUND"
      ) {
        const expectedSeat =
          seatRef.current?.gameId === requestedGameId
            ? seatRef.current
            : readSeatRecord(requestedGameId);
        const forgetResult = expectedSeat
          ? forgetSeat(expectedSeat)
          : "forgotten";
        if (forgetResult === "forgotten") {
          try {
            if (
              window.localStorage.getItem(LAST_GAME_STORAGE_KEY) ===
              requestedGameId
            ) {
              window.localStorage.removeItem(LAST_GAME_STORAGE_KEY);
            }
          } catch {
            // Ignore unavailable local storage.
          }
          setResumeGameId((current) =>
            current === requestedGameId ? null : current,
          );
        } else if (forgetResult === "storage-failed") {
          setError(
            "没有找到该对局，但浏览器无法安全清理座位记录；请释放站点存储空间后重试。",
          );
          return;
        }
      }
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
          networkMode={network?.mode}
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
          onStart={(options) =>
            void (options.matchType === "lan-human"
              ? startLanGame(options)
              : startGame(options))
          }
          onHome={goHome}
          onJoin={(code) => void joinLanGame(code)}
          network={network}
          onToggleLan={(enabled) => void handleToggleLan(enabled)}
          joinPrefill={joinPrefill}
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
          seat={seat}
          seatColor={seatColor}
          network={network}
          onReinvite={() => void handleReinvite()}
          onResolveUndo={(accept) => void handleResolveUndo(accept)}
          onRejoin={() => clearCurrentGame("mode", { clearSeat: true })}
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
