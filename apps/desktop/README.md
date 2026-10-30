# apps/desktop

Electron 桌面端（施工单 15 §2，已实装）。主进程内嵌**私有 host**（`port: 0`，只绑
`127.0.0.1`），窗口加载同一份 `apps/web`——没有第二套前端，也没有专用桌面布局。

```bash
pnpm build && pnpm desktop:dev     # 开发态起窗口
pnpm desktop:pack                  # 便携 zip → dist-desktop/
pnpm desktop:accept                # 逐项验收（16 条，每条独立）
```

| 目录/文件 | 作用 |
|---|---|
| `src/main.ts` | 生命周期（单实例 / boot / 窗口 / 四消息 / 退出） |
| `src/boot.ts` | 启动私有 host（sqlite 自检 / token 注入 / dev tsx / chdir） |
| `src/window.ts`、`src/window-options.ts` | BrowserWindow 与六道安全闸 |
| `src/ipc.ts` | `bah:boot/{injections,ready,fatal,shutdown}` 四消息 |
| `src/navigation.ts`、`paths.ts`、`audit-tab.ts`、`session-id.ts` | 纯函数（可单测） |
| `src/menu.ts`、`src/preload.ts` | 菜单与 contextBridge 最小面 |

完整说明（启动 / 离线演示 / 打包 / 排障 / 安全边界）见 [docs/desktop.md](../../docs/desktop.md)；
逐项验收记录见桌面端 03/04 单（证据件已随 2026-10-30 撤下，历史取 `git show b514496^:docs/evidence/`）。

⚠ 纯模块**不得 import electron**（`main.ts` / `window.ts` / `menu.ts` 例外）——
Electron 依赖会让 vitest 拿到一个需要 GUI 运行时的壳。门禁 `verify-desktop-shell` 会拦。
