# Contributing

感谢改进覆子。提交前请：

1. 使用 Node.js `>=22.12.0` 和 `npm ci`。
2. 不读取或利用未翻暗子的内部真实身份；Agent 逻辑只能依赖公开 API。
3. 为规则、并发、安全边界或 UI 行为变更补充可观察结果测试。
4. 运行 `npm run release:check`，并确认 `.local`、日志、token、`dist`、coverage、依赖目录和临时截图未暂存。
5. 保持 API 向后兼容；新增错误必须是稳定的结构化错误码。

贡献内容按仓库的 PolyForm Noncommercial 1.0.0 条款提供。商业授权讨论请使用专用 Issue 模板，且不要公开机密信息。
