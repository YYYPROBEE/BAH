# 桌面端（Electron）

> 施工单：[15 §2](../../BAH-桌面端施工方案-2026-10-29/00-总施工文档.md) · 分步 01/02/03
> 一句话：**Electron 主进程内嵌私有 host，窗口加载 `http://127.0.0.1:<随机端口>/`，UI 与 Web 完全同源。**

## 1. 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 私有宿主：主进程里 `boot()` 起一套完整 BAH（`channel:desktop`，`port: 0`） | 不是"套壳浏览器打开 `pnpm web`"（那要用户先起服务） |
| 复用 `apps/web` 的同一份 HTML/CSS/JS（零改动） | 没有桌面专用布局、没有第二套前端 |
| 便携 zip：解压双击 `BAH.exe` | 没有安装包、没有签名、没有自动更新 |
| 断网可演示（`router` 模型 + 审批 + 审计视图） | 不承诺在线模型 / RAG 检索 / 坐席接管 |

## 2. 启动（开发态）

```bash
pnpm install            # 首次：会从 npmmirror 拉 Electron 二进制（约 100 MB）
pnpm build              # 首次/改包后：workspace 包的 dist（桌面端 import 的是它们）
pnpm desktop:dev        # 构建 main/preload 并启动窗口
```

窗口打开后：

- 标题栏是页面标题（`BAH · 银行智能体`），不是 `BrowserWindow` 的 `title`——Electron 用页面
  `<title>` 覆盖窗口标题，这是预期行为；
- 控制台（主进程 stdout）会依次打印 4 条 JSON 日志：
  `desktop.starting` → `desktop.host-ready`（带实际端口）→ `desktop.ipc-received`（`bah:boot/ready`）
  → `desktop.ipc-sent`（`bah:boot/injections`）→ `desktop.window-loaded`。

> `pnpm desktop:dev` 需要先 `pnpm build`：主进程 import 的是 `@bah/host` 等包的 `dist/`，
> 不是 `src/`。这是刻意的——见 §5「为什么不把 workspace 包打进 bundle」。

## 3. 日常操作

| 动作 | 位置 | 说明 |
|---|---|---|
| 审计视图 | 菜单「视图 → 审计视图」（`Ctrl+Shift+A`） | 点的是 Web 的 `id="tab-audit"`；页面里没有这个 id 会留一条 `desktop.audit-view-missing` 告警 |
| 打开会话目录 | 菜单「文件 → 打开会话目录」 | `%APPDATA%\bah-desktop\sessions`（`shell.openPath`，只开目录不开 URL） |
| 重新载入 | 菜单「视图 → 重新载入」（`Ctrl+R`） | 等价于页面刷新；会话状态不受影响（宿主没重启） |
| 开发者工具 | 菜单「视图 → 开发者工具」（`Ctrl+Shift+I`） | **仅开发态出现**，打包后不挂这个菜单项 |

## 4. 离线演示（验收用）

1. **禁用网卡**（或拔网线）——不是"关掉 WiFi 但还连着有线"。
2. 双击 `BAH.exe`（打包形态，见 §6）；开发态则 `pnpm desktop:dev`。
3. 幕 1：查余额 → 对话流里出现工具卡三态（待执行 → 完成）。
4. 幕 2：转账预览 → 黄级审批弹窗 → 点"允许一次" → 核销。
5. 幕 3：切「审计」tab → 时间线里有工具调用与审批记录。
6. 幕 4：**关闭窗口再打开 = 一个新会话**（会话 ID 形如 `desktop-20261030-025431`）。
   历史不在界面里回放，用审计 CLI 看：
   ```bash
   pnpm bah audit --dir "%APPDATA%\bah-desktop\sessions\demo\desktop-20261030-025431"
   ```
7. 记录：窗口截图、审计截图、`process.versions.node`、zip 的 sha256。

> 为什么幕 4 不是"重开看历史"：平台没有 session resume（`jsonl:create` 对已存在会话排他失败，
> `provideSession` 也不回放磁盘）。详见 `apps/desktop/src/session-id.ts` 的模块注释与
> `docs/evidence/2026-10-30-desktop/` 的偏差表 D-02-4。

## 5. 关键设计（读代码前先读这段）

### 5.1 端口是 0，不是 7331

`profiles/desktop/patch.yml` 写 `port: 0`，主进程从 `DESKTOP_SERVER` 取**实际**端口再
`loadURL`。写死端口的两个后果都是现场级的：与 Web 演示撞车、以及"上一次能用这次不能用"。

### 5.2 必须先 `process.chdir(bahRoot)`

`channel:desktop.staticRoot: apps/web`、`core:persistence.root`、`policy:rules.root` 都相对
`process.cwd()` 解析。dev 的 cwd 是 `apps/desktop`，packaged 的 cwd 是 `dist-desktop/BAH/`，
**两者都不是** profile 相对的那个根。少了 chdir，表现是白屏 + 404 而不是崩溃。

### 5.3 为什么不把 workspace 包打进 bundle

方案原文要求 `noExternal: [/^@bah\//]`（"避免 pnpm 符号链接进 zip"）。实测两条硬伤：

1. **同一模块两份**：`main.mjs` 内联一份 `@bah/util`，外部包（如 `@bah/safety/dist`）又
   `import` 一份 ⇒ 全仓 21 处 `error instanceof BahError` 跨副本恒为 `false`，错误码静默退化；
2. **打散沙箱的文件定位**：`@bah/safety` 的 `sandbox-runtime/modules.ts` 靠
   `import.meta.url` 向上找自己的 `package.json` 来决定 worker 路径；内联后起点变成
   `dist/main.mjs`，一路到盘根也找不到 ⇒ 启动直接 `package-root-missing`。

所以主进程只产"接线"（约 28 KB），依赖靠 `node_modules` 真实目录（打包时扁平化拷贝）。

### 5.4 会话 ID 每次启动都不同

见 §4 幕 4 与 `apps/desktop/src/session-id.ts`。

## 6. 打包

`pnpm desktop:pack` → `dist-desktop/BAH-desktop-<version>-win-x64.zip`（详细步骤、体积、
sha256 见 03 单的回执与本节后续更新）。

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 窗口白屏，日志 `desktop.window-loaded` 正常 | 静态根找错（少了 chdir 或 `apps/web` 没进包） | 看 `desktop.starting` 里的 `web` 路径是否存在 |
| 启动即弹「BAH 启动失败 / desktop-sqlite-unavailable」 | Electron 内置 Node 没有 `node:sqlite`（< 22.5） | 升 Electron；本方案锁 39.x（Node 22.22 + Chromium 142，实测可用） |
| 弹「desktop-tsx-unavailable」 | dev 态没装 `tsx`（`node_modules` 不齐） | `pnpm install` |
| 弹「bah-boot: web-listen-failed」 | 端口绑不上（极少见：`port:0` 只可能命中禁用端口表） | 重开即可；连续 8 次命中才会失败 |
| 点「审计视图」没反应 | 页面里没有 `id="tab-audit"`（Web 重构过） | 看 `desktop.audit-view-missing` 告警；`pnpm gate` 的 G8 会先拦下这种改动 |
| 日志 `runtime.session-listener-failed: 会话已存在` | 有人把会话 ID 改回了固定值 | 会话 ID 必须是 `desktop-<时间戳>`，见 §5.4 |
| 第二次双击没反应 | 单实例锁（已有窗口被聚焦） | 预期行为：`requestSingleInstanceLock` |
| 杀软/SmartScreen 拦截 `BAH.exe` | 未签名 | 选择「仍要运行」；本方案不承诺绕过 |

## 8. 安全边界（一页版）

| 面 | 做法 | 门禁 |
|---|---|---|
| 窗口 | `contextIsolation` / `nodeIntegration:false` / `sandbox` / `webSecurity` 四项硬值 | G1 |
| IPC | 只有四条 `bah:boot/*`；注入载荷不含 token | G3 |
| preload | 只 `contextBridge.exposeInMainWorld('bahDesktop', {onInjections,onFatal,onShutdown,sendReady})` | G2 |
| 导航 | `will-navigate` 只放行同源 loopback；`window.open` 一律 deny；`webview` 拦 | G4 |
| 权限 | 请求与查询两个处理器都全拒（摄像头/麦克风/通知/剪贴板/地理位置） | G1 |
| 加载面 | 只 `loadURL(instance.url)`；源码里没有远程/`file://` 字面量 | G5 |
| 供应链 | 无自动更新、无外链打开、无崩溃上报 | G6 |
| 落盘 | 会话/记忆/saga 只在 `%APPDATA%\bah-desktop`，`resources/app` 只读 | 03 单 T-DTB-012 |
