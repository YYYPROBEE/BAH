# PROGRESS.md 瘦身 · 对抗式复审与二轮修复（2026-10-29）

被审对象：提交 `b0a8a4a`（第一轮瘦身）。审查者与被审者为同一主线程，**未分离**，
所以每条判据都写成可独立复算的形式，未实测的一律标「未证」。

## 1. 第一轮瘦身的产出与缺陷

| # | 条目 | 实测判据 | 处置 |
|---|---|---|---|
| P0-1 | §1 施工单进度表被当历史归档，而它是活的未完成清单（第 14/15/16 行仍是 `[ ]`） | `git diff $(git merge-base main imgw-line) imgw-line -- PROGRESS.md` 显示分支正在改该表第 15 行；`git merge-tree --write-tree main imgw-line` 报 `CONFLICT (content): Merge conflict in PROGRESS.md` | §1 表逐字请回 `PROGRESS.md` 当前面；归档不再声称覆盖 §1 |
| P0-2 | 编号权没归属，分支自增 §号撞车 | `git diff $(git merge-base main mobile-ui-fix-01) mobile-ui-fix-01 -- PROGRESS.md` 新增 `## 96.40 2026-10-29 移动 H5 走查修复`，与 main 的 `## 96.40 合流…` 同号 | 追加协议写明「编号由 main 分配，分支只写 `docs/evidence/`」 |
| P1-3 | 归档 21 处 markdown 相对链接因搬家全断，50 项门禁全绿抓不到 | 迁移前 `PROGRESS.md` 按根解析断链 0 处；迁到 `docs/` 后按 `docs/` 解析断链 21 处，且 21 处原本在根都成立（`facts.md` / `docs/pipeline.md` 等） | 21 处前缀机械修正（`relative()` 计算），并新增门禁 `verify-doc-links` 堵盲区 |
| P1-4 | 索引行区间系统性 off-by-one | 118 条索引与归档实际标题逐条对撞：117 条末行少 1；相邻条之间各留 1 行空洞 | 生成逻辑改 `to = 下一标题行号 − 1`，并加连续性断言 |
| P2-5 | 尾部 409 行里 298 行是已签收单正文，与头部「只记还没收口的」自相矛盾 | 逐节行数实测：§96.28–§96.36 共 255 行（含边界空行） | 该 9 节逐字迁进归档，归档改名覆盖到 10-28 |
| P2-6 | 索引按文件顺序而非编号顺序，且未标注 | 编号序列实测 `96.1,96.2,96.9,96.7,…`；`96.27` 出现 2 次 | 索引上方注明「文件顺序，重号与乱序原样保留」 |
| P3-7 | 提交信息数字过期 | 信息写 50,495 字节，提交实况 50,560 字节（写完后又改过一行头部） | 本轮改为「先测后写」：实测数字回填进文件头部并断言一致 |

## 2. 排除项（我一度怀疑、实测证伪）

- 视觉口径 R3「设计系统自称」：迁移确实把 1 条命中行带出 `NAMING_SURFACE`，但该行含
  `design/bah-ds/**`，命中 `scripts/verify-visual-line.ts:176` 的基线路径豁免 → 净覆盖损失 0。
- `packages/runtime/src/session/types.test.ts` 只在注释里引用 `PROGRESS R27`，不读文件。
- `docs-paths` 覆盖不降反升：扫描面 68 → 69 份文档（`docs/*.md` 实测 67 + `AGENTS.md` + `PROGRESS.md`）。
  这正是归档留在 `docs/` 顶层而非 `docs/archive/` 的原因——`verify-docs-paths.ts:81` 的
  `docFiles()` **不递归**。
- 「靠 `git show` 复算等价」这条判据本身会造假警：`core.autocrlf=true`，blob 是 LF、
  工作树是 CRLF，差值恰为行数 6,126；规范化后才可比。

## 3. 本轮修复的自证方式

参照系取迁移前的 git 对象 `c2d140c:PROGRESS.md`（不是我自己导的备份）：

1. **无损断言一**：把 `原头部 / §1 块 / §2–§96.27 / §96.28–§96.36 / §96.37–§96.41` 五块按
   原序拼接，与 blob 逐行全等（6,126 行内容）→ 证明没有任何块被增删或块内改序。
2. **无损断言二**：重排后两个文件的每一行，要么逐字存在于 blob，要么属本轮新写的
   横幅/索引/头部，要么是被修链接的那一行（且其原文仍在 blob 里）。
3. **连续性断言**：索引每条 `to + 1 = 下一条 from`，首条 `from = 横幅 + 原头部 + 1`。
4. **数字先测后写**：文件行数在写盘后从磁盘重测，回填进头部占位符，再断言回填后行数未变。

## 4. 仍存在的缺口（未证 / 未做）

- `verify-doc-links` 落库需要重跑 `npx tsx scripts/gen-architecture.ts`：门禁数被注入
  `docs/architecture.md` / `docs/algorithms.md` / `docs/security-design.md` 的生成块，
  而这三份是并行会话**未提交**的文件（实测：把新门禁移出仓库后 `verify-architecture` 即转绿）。
  因此该门禁暂存出场，未随本轮提交。暂存位置 `temp/doc-links-gate/`（仓外，不入库），
  含 `verify-doc-links.ts`、`doc-links.test.ts` 与 `__fixtures__/doc-links/` 4 份夹具；
  自测实测 6/6 通过，其中两条反夹具专门钉住"根目录成立、搬进 `docs/` 即断"这一类。
  该门禁落库时必须同批：重跑 `gen-architecture`、`facts.md` 改 **51/51**、
  `docs/facts-sources.md` 的 `gates=51` 与取值表行、以及 `README.md` 与
  `docs/security-self-assessment.md` 里的 `50/50`（由 `verify-docs-consistency` 强制）。
- `imgw-line` / `mobile-ui-fix-01` 两条未合入分支与 main 的 PROGRESS.md 冲突仍需人工解决；
  `mobile-ui-fix-01` 工作树有 133 个脏文件。
- 其余 6 份在用文档仍写「见 `PROGRESS.md` §xx」，经用户拍板**不补指针**（P2-6 同源决策）。
- 8 个 worktree 的 `PROGRESS.md` 副本本轮未动（用户选择先只动主仓）。
- `AGENTS.md` 门禁表写 `pnpm gate`（27 项），实测 50 项——本轮未修，属另一处文档漂移。
