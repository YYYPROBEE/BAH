/**
 * 跨文档一致性门禁（C1）。
 *
 * ## 为什么需要它
 *
 * `verify-facts` 只比对 `facts.md` 与源码重算值；它**不看** README / deploy 等
 * 对外材料里的数字。结果就是"facts 对了、deploy 还写 27 项门禁"——
 * 审阅者随手点开哪份文档，看到的就是哪份的旧数。
 *
 * 本门禁补三件事：
 *
 * 1. **旧数黑名单**：一批已确定过期的数字在对外材料里出现即红；
 * 2. **当前数一致**：对外材料里写的"用例数 / 门禁数 / 快照数 / 工具数"必须等于
 *    `docs/facts-sources.md` 机器块里的值；
 * 3. **能力口径防回退**：C3/C4/C5 之后，某些表述已经变成**错误**（"HALT 重启即清零"
 *    "记忆层未接线" "无人工接管平面"）。这类话在对外材料里出现即红——比数字过期更危险，
 *    因为它是"把已做的能力说成没做"，同样是不诚实。
 * 4. **过程件不得回流**：归档记录、证据原件、过程记录等路径出现在树里即红（见 `FORBIDDEN_PATHS`）。
 *
 * ## 白名单
 *
 * 历史件（drill-* / handoff-* / next-* / task-* / plans/* / preflight-*）记录的是**当时**
 * 的输出，改它们等于篡改证据。它们不在扫描面内；扫描面是硬编码的"对外材料"清单。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Gate, GateResult } from './gate-lib.ts'
import { projectRoot } from './gate-lib.ts'

/**
 * 对外材料清单（审阅者可能直接点开的文件）。
 *
 * 刻意**不**用 `walk` 扫 docs/：那会把历史件与内部设计一起卷进来，
 * 于是要么写一堆白名单例外，要么只能把判据放宽到没用。
 */
const PUBLIC_DOCS: readonly string[] = [
  'README.md',
  // `facts.md` 刻意不在扫描面：它是**基准源**，由 `verify-facts` 逐项比对；
  // 放进来会逼它同时扮演"被检查者"，一改数字就先红。
  // （清单从 README 开始，facts 由 verify-facts 守）
  'docs/deploy.md',
  'docs/security-design.md',
  'docs/web-frontend.md',
  'docs/tenant.md',
  'docs/contracts/tenant-model.md',
  'docs/knowledge.md',
  'docs/policy.md',
  'docs/plan.md',
  'docs/audit.md',
  'docs/profile.md',
  // 移动 H5 的对外口径页（新建即必须进清单）
  'docs/mobile.md',
  // IM 网关的对外口径页（新建即必须进清单）
  'docs/im-gateway.md',
  // `docs/review/judge-walkthrough.md` 随 2026-10-30 撤下移出扫描面：留空条目会让
  // 数字黑名单静默落空（门禁不红，但保护面缩了），所以直接从清单里删掉。
  'docs/observability.md',
  'docs/performance.md',
  'docs/roadmap.md',
  'services/rag/README.md',
]

/** 已确定过期的数字（出现即红）。 */const STALE_NUMBERS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /27\s*项/, why: '门禁数曾是 27，现在见 facts（不要写具体数就写"见 facts.md"）' },
  { pattern: /29\/29/, why: '门禁数曾是 29/29' },
  { pattern: /34\/34/, why: '门禁数曾是 34/34' },
  { pattern: /40\s*项/, why: '门禁数曾是 40，现在见 facts（不要写具体数就写"见 facts.md"）' },
  { pattern: /40\s*个\s*verify/, why: '门禁数曾是 40 个 verify-*' },
  { pattern: /41\/41/, why: '门禁数曾是 41/41，现在见 facts' },
  { pattern: /42\/42/, why: '门禁数曾是 42/42，现在见 facts' },
  { pattern: /43\/43/, why: '门禁数曾是 43/43，现在见 facts' },
  { pattern: /18\/18/, why: '快照数曾是 18/18（现在是 6 文件 23 例）' },
  { pattern: /1811\s*用例/, why: '用例数曾是 1811' },
  { pattern: /1951\s*用例/, why: '用例数曾是 1951' },
  { pattern: /2019\s*用例/, why: '用例数曾是 2019' },
  { pattern: /(?:web|前端)[^\n]{0,24}55\s*例/, why: 'web 用例数曾是 55，现为 57（pnpm test:web）' },
  { pattern: /(?:eval|评测)[^\n]{0,24}155\s*例/, why: 'eval 用例数曾是 155，现为 158（pnpm eval:unit）' },
  { pattern: /14\s*工具|14\s*个工具/, why: '工具数曾是 14，现在是 16' },
  { pattern: /sessions\/<sessionId>\//, why: '租户化后路径是 <deploy-root>/<tenant>/<sessionId>/（01/04）' },
  { pattern: /种子日限额.{0,6}5000|5000\s*元.{0,8}限额/, why: '种子日限额已对齐 1000 元' },
  // 覆盖率不列黑名单：`verify-facts` 用 `coverage-baseline.json` 判当前值，
  // 而文档里合法引用"上一版 84.49%"作为对比是允许的。
]

/**
 * 能力口径防回退（C3/C4/C5 已改变的事实）。
 *
 * 每条都要"确实已经变了"才登记：这些是**判断性**断言，不是数字替换。
 */
const WRONG_CLAIMS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /重启即清零|重启后清零|重启即解除/,
    why: 'C3 起 HALT 落 `halt.json`，重启后仍是 HALTED（只有凭票据解除才清盘）',
  },
  {
    pattern: /记忆层.{0,12}(未接线|未注册|不提供任何服务)|memory-store.{0,12}(未接线|未注册)/,
    why: 'C4 起 `bah:memory-store` 已注册服务并接线（写入 turn/end、召回 agent/pre-step、提示词段注入）',
  },
  {
    pattern: /无人工接管|没有人工接管|没有运行时 handoff|无 handoff/i,
    why: 'C5 起有最小接管平面：`POST /api/handoff` → `/api/turn` 409 → `POST /api/handoff/resume`',
  },
  {
    pattern: /没有\s*trace\s*导出|无\s*trace\s*导出|没有成本看板/,
    why: '观测面（01–03）已提供 `/api/trace` + Chrome Trace 导出与成本卡；旧口径已过期',
  },
  {
    pattern: /没有真实登录|无真实登录/,
    why: '02 起 `password` 模式已落地（scrypt + HttpOnly 会话 + 登录/登出/撤销），不再是"无登录"',
  },
  {
    pattern: /没有租户隔离|无租户概念/,
    why: '01/04 起租户 = 部署边界：目录 / 端口 / 令牌 / 密钥四道边界；一进程 N 租户才是"不做"的那条',
  },
  {
    pattern: /多租户要按租户分区/,
    why: '04 起会话、审计、记忆、指标、HALT 已按租户分区；仍不做的是一进程 N 租户（ADR-0004）',
  },
  {
    pattern: /单用户部署成立/,
    why: '04 起支持同机两租户并存（两个进程）；"单用户"不再是对外口径',
  },
  {
    pattern: /鉴权性质\s*\|\s*\*\*不是登录\*\*/,
    why: '`static` 的 Bearer 不是登录，但 `password` 模式是登录；不能再用"鉴权性质 = 不是登录"概括',
  },
]

/**
 * 过程件路径：不得进入默认分支的树。
 *
 * 归档记录、证据原件、过程记录、演练单与一次性复审稿是**开发过程**的产物，
 * 不是对外文档。它们被撤下后如果随某个分支合并回来，这条规则负责让提交变红；
 * 需要保留时放仓库外的归档目录，不要放回 `docs/`。
 */
const FORBIDDEN_PATHS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^\.md$/, why: '归档记录不随仓库分发' },
  { pattern: /^DECISIONS\.md$/, why: '内部决策记录不随仓库分发' },
  { pattern: /^docs\/evidence\//, why: '证据原件不随仓库分发' },
  { pattern: /^docs\/review\//, why: '评审/走查稿不随仓库分发' },
  { pattern: /^docs\/plans\//, why: '实现计划不随仓库分发' },
  { pattern: /^docs\/handoff-/, why: '过程记录不随仓库分发' },
  { pattern: /^docs\/drill-/, why: '演练单不随仓库分发' },
  { pattern: /^docs\/next-(?:actions|orders|three)-/, why: '内部排期不随仓库分发' },
  { pattern: /^docs\/preflight-/, why: '开工前体检记录不随仓库分发' },
  { pattern: /^docs\/progress-archive-/, why: '台账归档不随仓库分发' },
  { pattern: /^docs\/snapshot-sandbox-scenario-/, why: '一次性场景简报不随仓库分发' },
  { pattern: /^docs\/tech-debt-review-/, why: '一次性技术债评审不随仓库分发' },
  { pattern: /^docs\/web-frontend-review\.md$/, why: '一次性前端评审不随仓库分发' },
  { pattern: /^docs\/release-baseline-/, why: '内部基线快照不随仓库分发' },
  { pattern: /^docs\/dsh-comparison\.md$/, why: '内部对标材料不随仓库分发' },
]

/** 目录遍历时整棵跳过的路径（构建产物 / 依赖 / 测试产物 / 临时目录）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.ci-artifacts', 'dist', 'coverage', '.tmp-docsfix'])

/** 从 facts-sources 的机器块读当前值。 */
interface Facts {
  readonly gates: number
  readonly tools: number
  readonly testFiles: number
  readonly testCases: number
  readonly snapshotFiles: number
  readonly snapshotCases: number
}

function readFacts(root: string): Facts | undefined {
  const path = join(root, 'docs/facts-sources.md')
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  const value = (key: string): number | undefined => {
    const match = new RegExp(`^${key}=(\\d+)$`, 'm').exec(text)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  const gates = value('gates')
  const tools = value('tools')
  const testFiles = value('tests_main_files')
  const testCases = value('tests_main_cases')
  const snapshotFiles = value('snapshot_files')
  const snapshotCases = value('snapshot_cases')
  if (
    gates === undefined ||
    tools === undefined ||
    testFiles === undefined ||
    testCases === undefined ||
    snapshotFiles === undefined ||
    snapshotCases === undefined
  ) {
    return undefined
  }
  return { gates, tools, testFiles, testCases, snapshotFiles, snapshotCases }
}

/** 读一份对外材料（不存在就跳过，不制造假红）。 */
function readPublic(root: string, relative: string): string | undefined {
  const path = join(root, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 扫描全树，过程件出现即红。 */
function findForbiddenPaths(root: string, findings: string[]): number {
  let scanned = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    const relative = stack.pop()
    if (relative === undefined) break
    const entries = readdirSync(join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child)
        continue
      }
      scanned += 1
      const hit = FORBIDDEN_PATHS.find((rule) => rule.pattern.test(child))
      if (hit !== undefined) findings.push(`${child}: 过程件不得进入默认分支 —— ${hit.why}`)
    }
  }
  return scanned
}

export const gate: Gate = {
  name: 'docs-consistency',

  run(root: string): Promise<GateResult> {
    void projectRoot()
    const findings: string[] = []
    const notes: string[] = []

    const facts = readFacts(root)
    if (facts === undefined) {
      return Promise.resolve({
        ok: false,
        findings: ['docs/facts-sources.md 缺失或机器块不完整（无法判定一致性）'],
        notes: [],
      })
    }

    let scanned = 0
    for (const relative of PUBLIC_DOCS) {
      const text = readPublic(root, relative)
      if (text === undefined) continue
      scanned += 1

      for (const rule of STALE_NUMBERS) {
        if (rule.pattern.test(text)) {
          findings.push(`${relative}: 命中过期口径 ${rule.pattern.source} —— ${rule.why}`)
        }
      }
      for (const rule of WRONG_CLAIMS) {
        if (rule.pattern.test(text)) {
          findings.push(`${relative}: 命中已失效的能力表述 ${rule.pattern.source} —— ${rule.why}`)
        }
      }

      // 当前数一致：只在文档**确实提到**该数字时才比对（没提到不算错）
      const cases = /(\d{2,4})\s*文件\s*\/\s*(\d{3,5})\s*用例/g
      for (const match of text.matchAll(cases)) {
        // eval / snapshot / web 三个面各有自己的用例数，不是主仓口径
        const lead = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0)
        if (/eval|snapshot|web|前端/.test(lead)) continue
        const files = Number(match[1])
        const count = Number(match[2])
        if (files !== facts.testFiles || count !== facts.testCases) {
          findings.push(
            `${relative}: 用例数写成 ${String(files)} 文件 / ${String(count)} 用例，` +
              `facts 是 ${String(facts.testFiles)} / ${String(facts.testCases)}`,
          )
        }
      }

      const snapshots = /(\d{1,2})\s*文件\s*\/\s*(\d{1,3})\s*例/g
      for (const match of text.matchAll(snapshots)) {
        const files = Number(match[1])
        const count = Number(match[2])
        if (files !== facts.snapshotFiles || count !== facts.snapshotCases) {
          findings.push(
            `${relative}: 快照数写成 ${String(files)} 文件 / ${String(count)} 例，` +
              `facts 是 ${String(facts.snapshotFiles)} / ${String(facts.snapshotCases)}`,
          )
        }
      }

      // 允许表格写法（`| 门禁 | 36/36 |`）：中间可能隔着 `|` 或空格
      const gates = /(?:门禁|gate)[^\n]{0,8}?(\d{1,3})\s*\/\s*(\d{1,3})/gi
      for (const match of text.matchAll(gates)) {
        const passed = Number(match[1])
        const total = Number(match[2])
        if (total !== facts.gates || passed !== facts.gates) {
          findings.push(
            `${relative}: 门禁写成 ${String(passed)}/${String(total)}，facts 是 ` +
              `${String(facts.gates)}/${String(facts.gates)}`,
          )
        }
      }

      // 只比对"总数"口径（两位数以上）；示例里的"3 个工具"不是总数，不该误报
      const tools = /(\d{2,3})\s*个工具/g
      for (const match of text.matchAll(tools)) {
        if (Number(match[1]) !== facts.tools) {
          findings.push(
            `${relative}: 工具数写成 ${String(match[1])}，facts 是 ${String(facts.tools)}`,
          )
        }
      }
    }

    const treeFiles = findForbiddenPaths(root, findings)

    notes.push(`扫描对外材料 ${String(scanned)} 份；白名单外历史件不参与（改它们等于篡改当时输出）`)
    notes.push(
      `基准：门禁 ${String(facts.gates)}/${String(facts.gates)} · 用例 ${String(facts.testFiles)} 文件 / ` +
        `${String(facts.testCases)} 用例 · 快照 ${String(facts.snapshotFiles)}/${String(facts.snapshotCases)} · ` +
        `工具 ${String(facts.tools)} 个`,
    )
    notes.push(`过期数字规则 ${String(STALE_NUMBERS.length)} 条、能力口径规则 ${String(WRONG_CLAIMS.length)} 条`)
    notes.push(
      `过程件路径规则 ${String(FORBIDDEN_PATHS.length)} 条，扫描 ${String(treeFiles)} 个文件`,
    )

    return Promise.resolve({ ok: findings.length === 0, findings, notes })
  },
}
