/**
 * `verify-docs-paths` 的例外名单（门禁扩容 07 §2-4）。
 *
 * 只收两类：
 * 1. **上游坐标**（`UPSTREAM_PATHS`）：`docs/dsh-comparison.md` 的左列是 DeepSeek Harness
 *    的包路径，用来标"该机制在上游的落位"。它们本来就不在本仓，不该被本仓门禁判红。
 * 2. **登记在案的"暂不存在"**：施工单/评审里引用的、已明确记录为待补或历史路径。
 *    每条都指向 `PROGRESS.md` 的偏差编号，便于回溯。
 *
 * 纪律：
 * - 已实装包里的失效引用是**真 bug**：改文档，不许进名单。
 * - 实装之后必须删掉对应条目，否则门禁就成了"规划永动机"的挡箭牌。
 */

export interface DocsPathExclusion {
  /** 相对仓库根的 posix 路径。 */
  readonly path: string
  /** 为什么引用一个不存在的路径是合法的。 */
  readonly why: string
}

/** `docs/dsh-comparison.md` 引用的上游（dsh）包路径：不是本仓资产。 */
const UPSTREAM_PATHS: readonly string[] = [
  'docs/subsystems/',
  'packages/settings',
  'packages/identity',
  'packages/feedback',
  'packages/storage',
  'packages/spill',
  'packages/compaction',
  'packages/sandbox',
  'packages/boot',
  'packages/todo',
  'packages/goal',
  'packages/plan/plan-mode',
  'packages/guard',
  'packages/context/agent-instructions',
  'packages/core/scope',
  'packages/session-query',
  'packages/session-title',
  'packages/interaction/tool-ask-user',
  'packages/client',
  'packages/sdk',
  'packages/web',
]

const UPSTREAM_WHY = 'dsh 上游路径（对照表左列 / 落位坐标），不是本仓资产'

export const DOCS_PATH_EXCLUSIONS: readonly DocsPathExclusion[] = [
  ...UPSTREAM_PATHS.map((path) => ({ path, why: UPSTREAM_WHY })),
  {
    path: 'snapshots/tsconfig.json',
    why: 'PROGRESS R25 登记的待补配置：快照面目前只经 vitest 转译，阶段 7 扩 harness 时才补',
  },
  {
    path: 'packages/runtime/src/tier/decide.ts',
    why: 'PROGRESS R89 记录的"施工单 09 原路径"：已拍板三级判决落在 bank/src/tools/tier.ts',
  },
  {
    path: 'packages/xxx/src/yyy.ts',
    why: '施工单 07 §2-4 里的示意写法（xxx/yyy 占位），不是真实文件',
  },
]
