/**
 * 根目录解析（桌面端 02 §2.2）。**纯函数**：不碰 `app`、不碰文件系统、不碰 `process`。
 *
 * 为什么单独成文件并且保持纯粹：`createHttpChannel` 的 `staticRoot` / `core:persistence.root`
 * / `policy:rules.root` 全都相对 **`process.cwd()`** 解析。打包后 exe 在 `dist-desktop/BAH/`，
 * 而 profile 里的 `apps/web` 在 `resources/app/` 下——两者不同源。这类"差一层目录"的错
 * 现场表现为**白屏 + 404**，不是崩溃，最难查。所以解析规则必须是可单测的纯函数（T-DTB-007）。
 */

import { join, resolve } from 'node:path'

/** 打包后应用根在 `resources/` 下的固定目录名（组装目标）。 */
export const PACKAGED_APP_DIR = 'app'

/** 解析根目录的输入（全部由调用方从 Electron 取，纯函数只做算术）。 */
export interface RootInput {
  /** `app.isPackaged`。 */
  readonly isPackaged: boolean
  /** packaged：`process.resourcesPath`。 */
  readonly resourcesPath: string
  /** dev：`apps/desktop` 的绝对路径（`__dirname` 的上两级）。 */
  readonly appDir: string
}

/**
 * 解析"BAH 仓库根 / 打包应用根"。
 *
 * - dev：`apps/desktop` 往上两级 = 仓库根；
 * - packaged：`<resources>/app`。
 *
 * 两条都是**唯一**正确值：dev 下写死仓库绝对路径会让同事的机器直接起不来；
 * packaged 下猜 `../` 会落到 `resources/` 而不是 `resources/app`。
 */
export function resolveBahRoot(input: RootInput): string {
  return input.isPackaged
    ? join(input.resourcesPath, PACKAGED_APP_DIR)
    : resolve(input.appDir, '..', '..')
}

/** 静态根（`channel:desktop.staticRoot` 的相对路径就是 `apps/web`，这里给出绝对路径备查）。 */
export function resolveWebRoot(bahRoot: string): string {
  return join(bahRoot, 'apps', 'web')
}

/**
 * 解析 userData 根（I-DT-08：会话/记忆/saga 只能写这里）。
 *
 * 传入 `app.getPath('appData')`（`%APPDATA%`），而不是 `app.getPath('userData')`：
 * `userData` 的名字来自 `package.json` 的 `name`（`@bah/desktop` → 目录名带 `@` 与 `/`，
 * Windows 上会落成 `%APPDATA%\@bah\desktop`，既难看又容易被清理工具误删）。
 * 这里固定一个**无作用域前缀**的名字，路径可预期、可写进文档。
 */
export function resolveUserData(appDataRoot: string): string {
  return join(appDataRoot, 'bah-desktop')
}

/** 会话目录（`run.jsonlDir`；租户段由 `core:persistence` 再拼一层）。 */
export function resolveSessionsDir(userData: string): string {
  return join(userData, 'sessions')
}

/** home 层目录（`readLayers` 的 `home`；桌面端不读用户级 patch，指向这里只为隔离）。 */
export function resolveHomeDir(userData: string): string {
  return join(userData, 'home')
}
