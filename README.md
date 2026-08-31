# 覆子 · 象棋盲棋

覆子是一个仅在本机运行的 source-available 象棋盲棋游戏。它支持同屏双人对战，以及由独立终端中的 Agent Runner 驱动本机 Ollama 模型。浏览器、Runner 和外部 Agent 共用同一套 Express 规则 API。

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
- 悔棋始终增加 `revision`；人机局回到人类上一轮落子前。

## Ollama Agent Runner

Runner 只读取公开局面和同 revision 的合法着法。Prompt 使用低温度、有限输出预算和严格的 `moveIndex + reason` JSON Schema。无效输出最多纠错一次，之后暂停，绝不随机代走。

控制台分别展示模型实际返回的 thinking、模型实际返回的 final、最终着法、简短理由、模型阶段耗时和应用侧提交耗时。显示及日志中的模型文本会移除 ANSI、OSC 和危险终端控制字符，界面明确标为“模型原始文本（已移除终端控制字符）”。能力接口不可用时，能力显示为未知，不会伪造 thinking。

模型速度取决于模型体积、量化、上下文和本机硬件，本项目不作硬件无关的速度承诺。

## API 与数据边界

完整契约见 [docs/API.md](docs/API.md)。所有写请求必须携带 `expectedRevision`；并发失败统一为 `409`。请求体只接受 UTF-8 JSON，最大 16 KiB，所有 Schema 拒绝未知字段。

服务只绑定回环地址，且会检查 Host 和浏览器 Origin。它没有多用户鉴权，不应暴露到局域网或公网。对局只保存在内存中，重启服务后丢失；浏览器的“恢复上局”仅保存本机 game ID，不持久化棋局。

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
- `server/`：REST API、Ollama、Agent Runner、终端与会话生命周期
- `shared/`：前后端共享契约
- `src/`：React 界面、可访问棋盘和恢复流程
- `skills/`：只通过公开 API 操作棋局的 Agent Skill
- `tests/`：单元、集成、安全、压力与浏览器测试

## 许可证与商业授权

Copyright 2026 zengxuanliu2005。

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)（[SPDX：`PolyForm-Noncommercial-1.0.0`](https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html)），属于 source-available 软件，不称为 OSI 开源软件；[OSI 对开源的定义要求不得限制商业领域使用](https://opensource.org/osd)。标准条款允许非商业目的下的使用、修改和分发；任何商业用途必须另获版权所有者书面许可。请通过仓库的“商业授权咨询”Issue 模板联系，并且不要在公开 Issue 中披露机密商业信息。
