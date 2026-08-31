# Security Policy

## Supported versions

安全修复目前只面向最新的 `1.x` 版本。

## Reporting a vulnerability

请优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能。不要在公开 Issue 中披露 token、会话文件、日志、未公开漏洞细节或可直接利用的 PoC。维护者会确认报告、评估影响，并在修复可用后协调披露。

## Threat model

覆子是单用户、本机回环应用，不提供账号、多用户鉴权、局域网或公网部署保证。安全假设包括：

- Express 和 Ollama 均只通过 loopback HTTP 使用；
- 本机用户能够读取自己有权限访问的进程和文件；
- `.local/agent-sessions` 是短期凭据，不应同步或提交；
- Agent 日志包含公开棋局和模型文本，应按敏感本地日志处理；
- 指定 Seed 的创建者天然知道 Seed，隔离保证是 API 不额外泄漏活动 Seed。

若要跨用户或跨主机部署，必须另行增加认证、授权、TLS、持久化隔离和运维审计；这不在 v1.0.0 支持范围内。
