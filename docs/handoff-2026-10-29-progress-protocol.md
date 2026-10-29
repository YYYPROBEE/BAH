# 接手件 · 施工台账协议（2026-10-29）

> **本件取代 `docs/handoff-2026-10-26-w20-next.md` 里"每单收尾补 PROGRESS.md 两节"的记账口径。**
> 那份文件的工程内容仍然有效（W 系列待办、判据、演练安排），只有"往 `PROGRESS.md` 堆正文"这一条作废。
> 适用对象：任何接着做 BAH 的会话或人。

## 1. 台账现在长这样

| 载体 | 内容 | 变化 |
|---|---|---|
| `PROGRESS.md` | 当前面：§1 施工单状态表（活的未完成清单）+ 126 条历史索引 + §96.37 起的近期收口与未决策项 | 346 行 / 35 KB（曾 6,126 行 / 492 KB） |
| `docs/progress-archive-2026-10-18_28.md` | §2 ～ §96.36 的逐单施工回执与双角度复审，**逐字**保留 | 5,962 行，只读历史 |
| `docs/evidence/<YYYY-MM-DD>-<slug>/` | 每单的正文：用例落点、负控清单、门禁日志、复审结论 | 逐单一个目录（已在用） |
| `facts.md` | 唯一数字来源：门禁数 / 用例数 / 覆盖率 / 工具数 | `verify-facts` 逐项重算，不一致即红 |

## 2. 收口时怎么做（三步，别再发明）

1. **正文写进 `docs/evidence/<日期>-<slug>/`**，不写进 `PROGRESS.md`。
2. **`PROGRESS.md` 只动两处**：§1 状态表把对应行 `[ ]` 改 `[x]`；若有未决策项，追加到文末未决策面。
3. **数字只改 `facts.md`**（并按 `docs/facts-sources.md` 的取值命令重算），别在台账里写"多少用例/多少门禁"。

**编号由 main 分配。** 分支与并行会话不要在 `PROGRESS.md` 自增 `§96.xx`——2026-10-29 实测
`mobile-ui-fix-01` 自拟的 `§96.40 移动 H5 走查修复` 与 main 的 `§96.40 人机接管+租户鉴权合流` 撞号。
合入 main 时再领编号。

## 3. 为什么必须这样（别再改回去）

- 同一个 500 KB 单文件在 **8 个 git worktree** 各有一份，每条分支都在尾部追加 → 合并冲突面等于整篇正文。
  实测 `git merge-tree --write-tree main <branch>` 对 `imgw-line` 与 `mobile-ui-fix-01` 都报
  `CONFLICT (content): Merge conflict in PROGRESS.md`。
- 归档放 `docs/` **顶层**而不是它的子目录：`scripts/verify-docs-paths.ts` 的 `docFiles()` 只扫
  `docs/*.md`（不递归），放子目录会静默退出路径校验。
- 逐字性由**平铺证明**兜底：参照系是迁移前的 git 对象 `c2d140c:PROGRESS.md`，五个逐字块无重叠覆盖其
  全部 6,126 行内容（仅 1 个纯空行未归属）。复算判据见
  `docs/evidence/2026-10-29-progress-slim/01-adversarial-review.md`。

## 4. 解决 PROGRESS.md 冲突的正确姿势

- **只取冲突的那几行**，不要整篇 `git checkout --theirs PROGRESS.md`——那会把 5,700 余行历史重新塞回当前面。
- `imgw-line` 改的是 §1 表"IM 网关与桌面端"那一行（该行已回到 `PROGRESS.md`），取分支侧文本即可。
- `mobile-ui-fix-01` 的 `§96.40` 需改号（main 已占用），且其工作树有 133 个脏文件，先让它收口再合。

## 5. 挂在别人手里的事

- **新门禁 `verify-doc-links`** 已写好但暂存仓外 `temp/doc-links-gate/`（6 条自测含反夹具，实测通过）。
  它会把门禁数 50→51 注入 `docs/architecture.md` / `algorithms.md` / `security-design.md` 的生成块，
  而这三分现在是并行会话**未提交**的文件 → 等它们入库后同批：重跑 `gen-architecture`、
  `facts.md` 改 **51/51**、`docs/facts-sources.md` 的 `gates=51` 与取值表行、`README.md` 与
  `docs/security-self-assessment.md` 的 `50/50`（由 `verify-docs-consistency` 强制）。
- 工作树里那 7 项他人改动 + 1 个未跟踪 `handoff.test.ts` 会让 `verify-tracked-sources` 一直红，
  与本件无关。
- **`main` 领先 `origin/main` 52 个提交**（2026-10-29 22:1x 实测）：归档卷与瘦身后台账目前只在本机
  `.git` 里。推送前请勿在任何 worktree 做 `git clean -fd` 之类的销毁性操作。

## 6. 当前实测基线（2026-10-29 22:1x，本轮回归）

`pnpm test` 295 文件 / 3349 例；`test:web` 375；`test:snapshot` 39；`eval:unit` 158；
`typecheck` / `lint` 通过；`pnpm gate` 49/50（唯一红为他人未入库源码触发的 `tracked-sources`）。
`facts.md` 仍记 `294 文件 / 3333 用例`，差值是他人未提交的 handoff 测试，等其入库自然对齐。
