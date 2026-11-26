# Antigravity Desktop Status Bar

给 Windows 版 **Google Antigravity Desktop** 的输入框底部工具行加一条 DSH 风格会话状态栏。统计跟随当前会话，点击各项可打开详情。

> Unofficial, local-only status bar for Google Antigravity Desktop on Windows. Not a VS Code extension and not affiliated with Google or DeepSeek.

## 显示什么

- **会话与速度**：状态栏嵌在输入框底部工具行，采用较大字号显示最近一次生成速度；轮数和步数收进详情。详情还显示模型用时、工具调用用时、首 token 平均（TTFT）和平均输出速度，速度来自本地库官方记录的首 token 与流式耗时字段。
- **额度环**：同心环外圈显示五小时额度剩余，内扇形显示周额度剩余；位于状态栏最左侧，内外圈使用不同颜色且不加分隔线。悬停不弹说明，点击查看剩余比例和重置时间。额度池按输入框当前模型选择：Gemini 使用 Gemini 池，Claude/GPT 使用共享池；数据通过本机 Antigravity Hub 查询。
- **Token 用量**：显示总量、未缓存输入、缓存读取、输出和缓存命中率；Token 总量前不放图标。
- **子代理**：按已记录的父子会话关系统计，显示真实子代理名称，不把主会话的历史轨迹或模型名算成子代理。
- **上下文**：显示最近一次有效采样的占用率。完成压缩后，若还没有新样本，显示「待采样」，直到下一次模型请求记录新值。

## 安装与卸载

本机验证环境：Windows 11、Antigravity Desktop 2.34.0。需要 Node.js 22.5+（用到 `node:sqlite`），且 `node.exe` 在 PATH 中。其它版本未经逐一验证。

1. 下载或克隆仓库，解压到任意目录；从系统托盘完全退出 Antigravity。
2. 双击 `install.cmd`。它会把插件复制到 `%LOCALAPPDATA%\AntigravityStatusBar`，备份当前用户的桌面和开始菜单中已有的 **Antigravity** 快捷方式，并让这些快捷方式加载插件。不修改官方安装目录或应用程序包，也不改任务栏已固定的图标。
3. 用原来的 **Antigravity** 快捷方式打开应用，再打开一条已有会话。没有选中会话时，状态栏正常隐藏。

若只关闭窗口而没有从托盘退出，Windows 可能沿用不带插件的旧实例。官方更新若重建了快捷方式，重新运行 `install.cmd` 即可。直接运行官方 `Antigravity.exe` 可以绕过插件；`uninstall.cmd` 恢复备份的快捷方式。

## 数据与限制

- 插件从本机 `~/.gemini/antigravity/` 只读解析 SQLite / Protobuf 统计，不上传会话数据。用量读取与解析在后台线程进行，监听数据库及 WAL 写入即时刷新；已提交但未合并的记录同样可见，生成中尚未写出的用量不估算。没有可用记录时，不会推测子代理名称或上下文百分比。
- 这是非官方集成，依赖桌面端的视图结构和本地数据格式；Antigravity 更新后可能需要适配。启动器通过短时开放的本机回环 Node Inspector 加载插件，正常加载后约 8 秒主动关闭；不适合与不可信的本机程序同机运行。
- 状态日志在 `%APPDATA%\Antigravity\antigravity-statusbar.log`。提交问题时请先检查、脱敏，不要附会话数据库或未裁剪的截图。

## 测试

```powershell
node test/mock-main.js
node test/wal-freshness.cjs
```

测试用合成会话验证挂载、切换、日志和 WAL 刷新，不需要安装 Antigravity，也不读取真实会话。

## License

MIT，见 [LICENSE](LICENSE)。
