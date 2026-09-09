# 覆子图文素材源文件

- [一页预览全部成品](gallery.html)
- [排版源文件](campaign.html)：编辑 HTML 中的文字与布局，样式在 `campaign.css`。
- [小红书文案](../../docs/promotion/xiaohongshu.md)
- [插画生成提示词](image-prompts.md)

## 导出

启动仓库的开发服务后，访问 `http://127.0.0.1:3001/res/source/campaign.html?art=01-cover`。将 `art` 换成 HTML 中的其他 section ID 即可预览对应版式。直接打开 HTML 也可预览；所有图片使用相对路径。

`export.txt` 是供 Playwright CLI `run-code --filename` 读取的函数表达式，不是产品代码。它从当前仓库目录运行，默认使用本机 3001 服务，逐张导出 PNG，并检查内容边界。保持源文件末尾没有分号，以兼容 CLI 的函数表达式解析。

```bash
playwright-cli -s=masked-promo open http://127.0.0.1:3001/res/source/campaign.html
playwright-cli -s=masked-promo run-code --filename res/source/export.txt
```

需要重新导出时先准备 Playwright CLI。六张小红书图片为 1080 × 1440；五张 README 图片为 1600 × 900。

## 素材来源

游戏截图于 2026-09-09 使用 Computer Use 在 Safari 中操作本地覆子采集，原图为 978 × 768。排版只通过 SVG viewBox 展示原图局部并缩放，不重绘界面或更改棋局。所有原图保存在 `../screenshots/`。

- `board-before` / `board-after`：同屏演示局第一手前后。红方五路暗子按兵行走，揭晓为黑方车。
- `move-hints`：同一手选中后的合法落点提示。
- `ai-game`：本机 `qwen3-vl:4b`、简单难度完成第一手后的实际画面；模型控制器随后已停止。
- `ai-settings`：人机设置界面，显示三档难度。
- `modes`：对战选择页；LAN 部分为真实入口截图，开关处于关闭状态。
- `lan-join`：实际加入对局界面，输入框为空，显示应用内示例占位符，没有有效邀请码。
- `home` / `tutorial`：游戏首页和交互教学。

插画背景使用内置 imagegen 生成，导出到 `../backgrounds/ivory-chess.png`。背景独立生成，游戏界面与正文通过 HTML/CSS 排版，避免生成模型改变棋子或文字。

用户提供的 `../example/` 仅用于研究展示方式，未复制其品牌、文案、设备截图或水印到成品。主要参考 Deadliner 的截图主体与留白、咖啡应用的纸感，以及游戏商店的一图一特色。README 另外参考 [AppFlowy 的展示结构](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md)，使用大图开场与特色分段。
