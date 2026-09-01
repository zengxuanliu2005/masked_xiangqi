# 覆子 · 象棋盲棋

覆子是一个 source-available 象棋盲棋游戏。它支持同屏双人对战、局域网双人对战（两台设备各看各的一方），以及由独立终端中的 Agent Runner 驱动本机 Ollama 模型。浏览器、Runner 和外部 Agent 共用同一套 Express 规则 API。

默认只监听 `127.0.0.1`；局域网对战需要显式开启。

> 安全边界：未翻暗子的真实身份只存在于服务端内存中。活动局的 Seed 对浏览器、公开 API、Prompt、Runner 状态和 JSONL 日志均为 `null`；终局后才公开 Seed。创建者若主动指定 Seed，本人天然知道该值，因此严格隔离只保证 API 不额外泄漏服务器生成或保存的活动 Seed。

## 环境与安装

- Node.js `>=22.12.0`（CI 同时检查 Node 22.12 和 Node 24）
- npm（使用锁文件安装）
- 可选：本机 [Ollama](https://ollama.com/)；人人对战不需要 Ollama

```bash
git clone git@github.com:zengxuanliu2005/masked_xiangqi.git
cd masked_xiangqi
npm ci
```

人机对战还需要安装 Ollama 并拉取一个可生成文本的模型，例如：

```bash
ollama pull qwen3:8b
ollama serve
```

如果 `ollama serve` 提示 `address already in use`，通常表示 Ollama 已经在后台运行；先执行 `ollama list` 或访问 `http://127.0.0.1:11434/api/tags` 验证即可。embedding-only 模型会显示为不可用于对弈。

## 开发与生产启动

开发模式同时启动 Vite 和 Express：

```bash
npm run dev
```

- 网页：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3001/api/v1`

跨平台生产启动：

```bash
npm ci
npm run build
npm start
```

`npm start` 不依赖 POSIX 环境变量语法，可在 macOS、Linux 和 Windows 使用。生产服务在 `http://127.0.0.1:3001` 同时提供网页与 API。完整生产烟测会重新执行 `npm ci → build → start`：

```bash
npm run smoke:production
```

### 常见问题

- 端口占用：停止占用 3001/5173 的旧进程，或为 API 设置 `PORT` 后单独启动。
- 找不到模型：确认 `ollama list` 有模型，并在设置页“重新检测”。模型在开局时会再次验证。
- 终端未打开：网页会把控制器标为暂停并显示可复制的手动命令。该命令包含本机会话文件路径，但不包含 token。
- Linux 无桌面：自动终端需要 `DISPLAY` 或 `WAYLAND_DISPLAY`；无桌面环境请复制手动命令到已有 shell。
- 终端瞬退：网页会在心跳超时后标为“已退出”，可用“重新打开控制台”恢复。

## 游戏流程

1. 首页可进入交互教学或选择对战。
2. 设置标准/吃主帅模式、自动和棋、悔棋、对手和 Seed。
3. 服务端随机分配 Player 1/人类的红黑方；人机局中玩家无论执红或黑都显示在棋盘下方。
4. 活动局 Seed 保密；终局结算公开 Seed，并提供“同 Seed 再来”。查看最终棋盘后可重新打开结算。
5. 刷新页面后，首页提供“恢复上局”。离开活动局会确认；确认后会停止旧 Runner。

### 规则摘要

- 标准 9×10 棋盘；帅、将明置，其余 30 枚真实身份按 Seed 均匀打乱并盖住。
- 暗子第一次按公开的位置身份移动，完成后揭面；之后按真实棋种和颜色行动。
- 被吃暗子会公开真实身份并进入吃子区。
- 标准模式包含应将、禁止送将、将帅照面、将死、困毙、直接吃主帅与可选三次重复和棋。
- 吃主帅模式取消将军约束，只以实际吃掉帅或将结束。
- 悔棋始终增加 `revision`；人机局回到人类上一轮落子前；同屏与局域网局撤回最近一步，局域网还需对方同意。

## 局域网对战

两个人各用自己的设备（手机、平板、电脑），在同一个 Wi-Fi 下对弈，各自只看到自己的一方。

1. 房主在模式页把「允许同一网络的设备连接」打开（或启动时加 `--lan`）。
2. 选「局域网对战 → 创建房间」，界面会显示 6 位房间码，以及每个候选私网地址对应的可复制链接。
3. 房主选择与对手同网段的地址；对方打开对应链接会直接看到已预填的加入框（也可自行访问 `http://<房主IP>:3001` 后点「我有房间码」），确认房间码入座。
4. 双方棋盘各自把自己的一方放在下方，只有轮到自己时才能落子。

```bash
npm run build
npm start -- --lan      # 或 LAN=1 npm start
```

也可以在运行中从界面开关：关闭、绑定和失败回滚按 FIFO 串行执行。界面每 150 ms 查询一次真实状态（前台最多等待 5 秒），只在新 listener 确认可用后显示切换完成；重绑瞬间的短暂断连会自动重试，前台超时后改为每秒后台对账直至得到终态。页面还会每 5 秒及窗口重新聚焦时刷新真实模式与网卡地址，DHCP 或其他标签页造成的变化无需重载即可反映到邀请卡。进程开始关机后控制器进入终态，晚到的切换请求不会重新打开 listener。

- **悔棋需对方同意**：只有刚走完那一步的一方能发起，对手在自己设备上批准或拒绝。替补尚未入座时不会开放请求；对方先落子、超时或终局都会让请求自动失效。
- **对手掉线**：房主会看到「对手已断线」，可以点「重新邀请」作废旧房间码并生成新的。旧设备会显示「你已被移出对局」。
- **离开或换局**：持有有效座位的设备会先以自己的座位认输并结束房间，成功后才条件清除一次性令牌。普通页面导航不会丢弃尚未恢复的席位；开始另一局会再次确认，瞬时恢复/结束失败会保留凭据以便重试。多个标签页并存时会先协调最新签发记录，旧标签页不能删除或覆盖新座位。
- 局域网对战只在生产模式（`npm run build && npm start`，单一来源 3001 端口）下承诺可用；开发模式下网页在 Vite 5173、API 在 3001，跨设备访问需要额外配置。
- mDNS 名称（`xxx.local`）会被 Host 检查拒绝，请使用界面给出的 IP 链接。

## Ollama Agent Runner

Runner 只读取公开局面和同 revision 的合法着法。Prompt 使用低温度、有限输出预算和严格的 `moveIndex + reason` JSON Schema。无效输出最多纠错一次，之后暂停，绝不随机代走。

控制台分别展示模型实际返回的 thinking、模型实际返回的 final、最终着法、简短理由、模型阶段耗时和应用侧提交耗时。显示及日志中的模型文本会移除 ANSI、OSC 和危险终端控制字符，界面明确标为“模型原始文本（已移除终端控制字符）”。能力接口不可用时，能力显示为未知，不会伪造 thinking。

模型速度取决于模型体积、量化、上下文和本机硬件，本项目不作硬件无关的速度承诺。

## API 与数据边界

完整契约见 [docs/API.md](docs/API.md)。对既有对局的状态写入必须携带 `expectedRevision`；并发失败统一为 `409`。重新邀请还必须匹配当前房间码，防止延迟重试撤销后来入座的设备。请求体只接受 UTF-8 JSON，最大 16 KiB，所有 Schema 拒绝未知字段。

服务默认只绑定回环地址，并以规范化后的 socket 对端地址识别真实调用方；`Host`、`Forwarded`、`X-Forwarded-For` 和 `X-Real-IP` 都不能证明请求来自本机。loopback Host 只接受 loopback 对端。开启局域网模式后改为监听 `0.0.0.0`，LAN Host 必须精确匹配服务器当前真实网卡的私网 IP 字面量，socket 对端也必须来自 loopback 或私网；域名、其他私网 Host、公网对端和同 IP 异端口 Origin 均被拒绝。

`POST /games`、`POST /rooms`、网络开关、AI 与 Agent 会话**始终仅限真实 loopback**；非 LAN 对局的落子、认输和悔棋同样只限本机。远程设备只可兑换房间码并使用座位令牌对弈。`agent-session` 会在宿主机上拉起终端进程，因此绝不对 LAN 开放。

局域网对战没有账号体系：同一网段内拿到房间码的人就能入座，且传输是明文 HTTP。新座位会立即保存在当前页面内存中；localStorage 仅用于尽力恢复刷新后的座位，并以单调签发代次、独立存储槽和保留代次的凭据墓碑协调多标签页；条件清理不会删除可能刚被旧版标签页替换的共享指针。即使浏览器拒绝写入也不影响当前对局；若旧凭据已持久化而安全清理失败，换局会停止并提示释放站点存储空间。请只在可信的家庭网络下开启，详见 [SECURITY.md](SECURITY.md)。

对局只保存在内存中，重启服务后丢失；浏览器的“恢复上局”仅保存本机 game ID，不持久化棋局。

Agent 凭据文件位于 `.local/agent-sessions/`、权限为 0600，并在停止、终局、退出、重启或过期时删除。JSONL 日志位于 `.local/agent-logs/`，可能包含公开棋盘、合法着法、模型 thinking/final、理由、错误和耗时；单文件上限 5 MiB，只保留一个轮转文件，启动时清理 7 天前日志。请按本地敏感日志管理。

## 验证

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:security
npm run test:stress
npm run test:e2e
npm run build
npm run release:check
```

在装有兼容模型的 macOS 真机上，可额外运行真实 Ollama 双路径烟测：

```bash
npm run smoke:ollama
```

默认使用 `qwen3.6-uncensored:q3kp` 验证实际 thinking 流，以及 `qwen3-vl:4b` 验证 `think=false` 的 direct 流；可分别用 `OLLAMA_THINKING_MODEL`、`OLLAMA_DIRECT_MODEL` 覆盖。

Playwright 覆盖 Chromium、Firefox 和 WebKit，并含固定桌面/平板/手机横竖屏矩阵与 axe 检查。重型 10 分钟压力测试在手动 workflow 和发布标签上运行；普通本地压力门禁使用相同断言的短时模式。真实 Ollama、Safari、VoiceOver、iTerm2 和 Terminal 仍属于 macOS 手动验收。

Windows/Linux CI 会真实启动 Node 服务并测试终端命令与带空格路径的参数构造，但不会声称验证了每个桌面终端 GUI。自动压力使用假 Ollama/假终端，避免把硬件和模型波动当成产品回归。

## 项目结构

- `engine/`：布子、走法、终局、公开投影和有界内存存储
- `server/lan/`、`server/net/`、`server/network.ts`：局域网房间与座位、Host 策略、监听地址控制
- `server/`：REST API、Ollama、Agent Runner、终端与会话生命周期
- `shared/`：前后端共享契约
- `src/`：React 界面、可访问棋盘和恢复流程
- `skills/`：只通过公开 API 操作棋局的 Agent Skill
- `tests/`：单元、集成、安全、压力与浏览器测试

## 许可证与商业授权

Copyright 2026 zengxuanliu2005。

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)（[SPDX：`PolyForm-Noncommercial-1.0.0`](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html)），属于 source-available 软件，不称为 OSI 开源软件；[OSI 对开源的定义要求不得限制商业领域使用](https://opensource.org/osd)。标准条款允许非商业目的下的使用、修改和分发；任何商业用途必须另获版权所有者书面许可。请通过仓库的“商业授权咨询”Issue 模板联系，并且不要在公开 Issue 中披露机密商业信息。
