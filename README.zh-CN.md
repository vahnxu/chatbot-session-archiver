# 本地 Chatbot 会话归档器

[English](README.md) | [简体中文](README.zh-CN.md)

这是一个 Chrome unpacked extension，用于**手动、仅本地**导出当前 AI chatbot 对话，包括文本和页面中可获取的附件。

点击浏览器工具栏图标后，当前 chatbot 会话会被保存为 `session.md`、`session.json` 和附件文件，写入你自己电脑上的本地目录。没有弹窗确认页，没有云端服务，没有分析统计。

## 这个项目解决什么问题

作者自己的使用场景是：

- **把一个 chatbot 会话保存到本地**，再导入另一个 chatbot 获得不同视角。例如之前在 ChatGPT 里聊了一段方案，现在想让 Claude 基于这段聊天记录再分析一次，给出不同角度的方案。
- **把一个 chatbot 会话保存到本地**，再交给 Codex / Claude Code 作为上下文，让 coding agent 接续处理。
- **保留自己可控的长期归档**，避免 chatbot UI 改版、账号关闭或 shared link 失效后找不回上下文。

如果你的目标是保存你自己的 chatbot 对话，这个工具适合你。如果你的目标是抓取别人的数据，或批量自动抽取聊天记录，这个项目不适合你。请先阅读 [范围和红线](#范围和红线)。

## 和平台全量导出有什么区别

很多 AI 平台自带账号级全量导出或备份功能。那适合周期性完整备份，但如果你只是想马上保存某一个会话，就会比较重。

这个工具保存的是**当前单个 session**。你可以按需保存一段对话，把它交给另一个 chatbot 或本地 agent 继续分析；新增内容也可以随时单独保存，不需要一次次导出整个账号。它适合灵活的增量保存，不替代平台官方全量备份。

## 会保存什么

每次保存会生成一个目录，结构类似：

```text
~/Documents/chatbot-archives/Claude/2026-05-03/20260503T124939Z_claude_<title-slug>/
├── session.md
├── session.json
└── attachments/
    ├── manifest.json
    ├── 001_<filename>.jpeg
    ├── 002_<filename>.pdf
    └── ...
```

`session.md` 适合人阅读，或复制到另一个 chatbot。`session.json` 适合交给 Codex、Claude Code 或你自己的脚本处理。

### 附件和图片

扩展会尽量保存 chatbot 页面已经暴露给浏览器的图片和文件附件，包括 `data:`、`blob:` 和普通 `http(s)` 来源。每条附件记录都会写入 `attachments/manifest.json`，并标注状态：

- `saved`：文件已保存到 `attachments/` 目录。
- `skipped`：页面只显示了附件名或附件卡片，但没有暴露可下载来源。
- `failed`：页面暴露了来源，但浏览器无法获取，或文件超过安全大小限制。

有些 chatbot 平台会把用户上传文件藏在内部接口后面，页面上只显示文件名。这种情况下，本工具会记录可见的文件名和不能保存的原因，但无法还原原始本地文件。

### 支持的 chatbot

ChatGPT、Claude、Gemini、DeepSeek、Kimi、Doubao、Perplexity、Grok、Qianwen、Poe、Copilot、Mistral。其他页面会走通用 fallback。

各个平台的网页 DOM 可能随时变化。DOM 变化后，该平台的保存质量可能下降，直到选择器更新。平台识别和选择器规则见 [docs/Spec.md](docs/Spec.md)。

## 工作原理

1. **Chrome extension** 只在你点击工具栏按钮时读取当前活动标签页中已经渲染出来的对话 DOM。
2. **Native messaging host** 是本地 Python 程序 `native_host.py`，通过 Chrome native messaging 协议接收数据，并写入本地归档目录。
3. **附件获取** 在页面上下文中完成，只保存当前页面已经暴露出来、浏览器可以取到的附件。无法获取的附件会记录为 `skipped`，不会伪造内容。

项目没有远程服务器、没有遥测、没有分析统计。可以运行 `scripts/verify_no_network.sh` 做静态检查。

## 安装

这不是 Chrome Web Store 的一键安装插件。你需要先从源码目录加载 unpacked extension，再运行一次 native host installer，让 Chrome 可以把会话 bundle 写到你的本地归档目录。

### 0. 前置条件

- Google Chrome，或支持 native messaging 的 Chromium 系浏览器
- Python 3.9+
- macOS 或 Linux。Windows 理论上可行，但当前安装脚本主要覆盖 macOS / Linux。

### 1. 获取源码

```bash
git clone https://github.com/vahnxu/chatbot-session-archiver.git ~/code/chatbot-session-archiver
cd ~/code/chatbot-session-archiver
```

### 2. 在 Chrome 里加载 unpacked extension

1. 打开 `chrome://extensions`。
2. 打开右上角 **Developer mode**。
3. 点击 **Load unpacked**，选择刚克隆下来的项目目录。
4. 记下 Chrome 显示的 extension ID。仓库内置稳定 `key`，正常情况下 ID 应该是 `jomoepphgememdnpipkhojpjmkjeehdl`。如果你的 ID 不同，安装 native host 时需要显式传入。

### 3. 安装 native messaging host

在项目目录运行：

```bash
python3 scripts/install_native_host.py
```

安装器会写入：

- Chrome native messaging manifest：`com.chatbotarchiver.host.json`
- 本地 wrapper 脚本：macOS 在 `~/Library/ChatbotSessionArchiver/`，Linux 在 `~/.local/share/chatbot-session-archiver/`

如果你的 Chrome extension ID 不同：

```bash
python3 scripts/install_native_host.py --extension-id <chrome-extensions-page里的ID>
```

Chromium、Brave、Edge 和手动 manifest 配置见 [docs/NativeMessaging.md](docs/NativeMessaging.md)。

### 4. 自定义保存目录，可选

默认保存到：

```text
~/Documents/chatbot-archives/
```

如果想换目录：

```bash
python3 scripts/install_native_host.py --target-dir "$HOME/Documents/my-chatbot-archives"
```

### 5. 重启 Chrome 并 reload extension

完全退出 Chrome 后重新打开。然后打开：

```text
chrome-extension://<your-extension-id>/popup.html?reload=1
```

### 6. Self-test

打开：

```text
chrome-extension://<your-extension-id>/popup.html?selftest=1
```

看到 `Self test passed.` 就说明 native host 和 extension 能正常通信，并且会在归档目录下生成一个 `SelfTest/.../session.md` 和测试附件。

如果看到 `ERR_BLOCKED_BY_CLIENT`，说明当前 Chrome profile 没有加载这个 unpacked extension。回到 `chrome://extensions`，重新 `Load unpacked`。

如果看到 `native host unavailable: Native host has exited`，先打开：

```text
chrome-extension://<your-extension-id>/popup.html?reload=1
```

然后再跑 self-test。

如果不确定是哪一层坏了：

```bash
python3 scripts/doctor.py
```

`doctor.py` 会检查 extension 源码目录、native messaging manifest 和 host wrapper。Chrome 的 persisted profile 状态只是辅助信息；真正权威的是 self-test 页面。

## 使用

1. 打开一个 chatbot 对话页面。
2. 如果对话很长，先向上滚动到最早的消息，确保历史消息都已经显示出来。扩展只能保存当前网页已经加载出来的内容。
3. 点击浏览器工具栏里的扩展图标。
4. 成功时会出现绿色 toast，显示保存路径；失败时会出现红色 toast。

工具栏图标是单击保存。没有 popup，没有确认弹窗，也没有云端请求。

## 范围和红线

这个工具只用于**个人手动保存自己的对话**。它不是：

- 批量抓取器或爬虫。没有 batch mode、没有调度、没有脚本化入口。
- 读取别人账号的工具。它只能读取当前标签页里你自己能看到的内容。
- 绕过平台服务条款的工具。如果某个平台的 ToS 禁止以这种方式导出内容，责任在使用者。

很多 chatbot 平台会限制自动化抽取。本项目刻意设计为手动点击保存当前可见会话，不要把它改造成自动化批量导出工具。

如果页面只显示附件文件名，但不暴露可获取 URL/blob/data source，原始本地文件无法被重建。bundle 会记录文件名，并在附件 manifest 中标记为 `skipped`。

## 权限说明

- `activeTab` + `scripting`：点击工具栏图标时，把 content script 注入当前活动标签页。
- `<all_urls>`：chatbot 域名开放且不断变化；扩展只在你点击时读取当前活动标签页，不会自动扫描浏览器。
- `nativeMessaging`：和本地 Python writer 通信。
- `storage`：保存最近一次 capture 的简要调试信息。

扩展没有声明 `downloads` 权限，不打开 WebSocket，不调用 analytics endpoint，也不联系固定远程 URL。

## 验证

在项目目录运行：

```bash
bash scripts/verify_no_network.sh
python3 scripts/check_release_safety.py
python3 scripts/doctor.py
python3 scripts/test_native_host_bundle.py
python3 scripts/test_install_native_host.py
python3 scripts/test_doctor.py
python3 scripts/install_native_host.py --dry-run
node --check background.js content.js popup.js
```

这些检查覆盖：

- extension JavaScript 和 native host Python 中没有固定远程端点或分析 API
- GitHub 公开仓库中没有本机路径、常见 secret、私钥块或 secret-looking 文件
- native host bundle 协议能完整写入 `session.md`、`session.json` 和附件
- installer 会写入显式 Python wrapper，并支持自定义保存目录
- doctor 能区分 extension 未加载和 native host 安装问题
- JavaScript / Python 语法检查

## 项目状态和支持

这是个人工具，按现状开源。**不承诺响应 issue 或 pull request。**

chatbot 网页 DOM 可能随时变化，某个平台坏了不代表本地保存架构坏了，通常是选择器需要更新。

如果你 fork 并改名发布，请使用自己的 native messaging host name 和 Chrome `key`，不要沿用作者的身份配置。

## License

Apache License 2.0. See [LICENSE](LICENSE).
