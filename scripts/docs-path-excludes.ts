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

/**
 * 本仓**不发布**的内部件：按 `.git/info/exclude` 不入库，只在作者工作区存在。
 *
 * 为什么要单列一类：`PROGRESS.md` / 交接单 / 事实台账当初确实是按这些路径引用的，
 * 而它们**永远不会**进仓库。两种修法里，改历史记录等于篡改当时的输入（`docs-consistency`
 * 也是这个口径），所以只能把它们登记成"不是本仓资产"——和 `UPSTREAM_PATHS` 同类，
 * 区别只是那些是别人仓库的坐标，这些是本仓自己的、但按提交纪律不入库。
 *
 * 代价写在这里，不假装它们存在：读者在 clone 里打不开这些路径。
 */
const PRIVATE_PLANNING_PATHS: readonly string[] = [
  'docs/preflight-2026-10-25.md',
  'docs/owners-2026-10-25.md',
  'docs/capacity-plan-b-2026-10-25.md',
  'docs/staffing-plan-2026-10-25.md',
  'docs/one-person-plan-2026-10-25.md',
  'docs/task-w10-2026-10-25.md',
  'docs/next-three-w11-w12-w05-2026-10-26.md',
  'docs/handoff-2026-10-25-w07-done.md',
  'docs/handoff-2026-10-25-w08-done.md',
  'docs/handoff-2026-10-25-w16-done.md',
  'docs/handoff-2026-10-26-w20-next.md',
]

const PRIVATE_PLANNING_WHY =
  '内部规划/交接件：按 .git/info/exclude 不入库，只在作者工作区存在（历史记录按当时路径引用，改文档等于篡改当时输入）'

export const DOCS_PATH_EXCLUSIONS: readonly DocsPathExclusion[] = [
  ...UPSTREAM_PATHS.map((path) => ({ path, why: UPSTREAM_WHY })),
  ...PRIVATE_PLANNING_PATHS.map((path) => ({ path, why: PRIVATE_PLANNING_WHY })),
  // 运行期目录：内容一律不入库（`*.sqlite` 知识库、fastembed 模型缓存），
  // 干净 clone 上本就不该有 —— `store.py:202` 自建父目录，容器按 `-v` 挂载宿主目录。
  {
    path: 'services/rag/data',
    why: '运行期数据目录：内容是本地知识库（*.sqlite 已忽略），store.py 自建父目录、容器按 -v 挂载，干净 clone 上不该有',
  },
  {
    path: 'services/rag/models',
    why: '运行期模型缓存目录：fastembed 首次运行自建，内容不入库',
  },
  {
    path: 'services/rag/models/',
    why: '同上；门禁按精确串匹配，文档里带尾斜杠的写法需单列',
  },
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
