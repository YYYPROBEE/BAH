# BAH 施工进度（当前面）

> **本文件只记三样：活的未完成清单（§1）、每单一行索引、以及 2026-10-29 起的收口与未决策项。**
> §2 ～ §96.36（2026-10-18 ～ 10-28 的逐单施工回执与双角度复审）已**逐字**迁到
> [docs/progress-archive-2026-10-18_28.md](docs/progress-archive-2026-10-18_28.md)，
> 原 `§编号` / 偏差编号 `R*` 不变，旧引用按编号继续可查（下方索引给出实际行区间）。
> 门禁数 / 用例数 / 覆盖率**一律以 [facts.md](facts.md) 为准**（`pnpm gate` 的 `verify-facts` 逐项比对），
> 不要从本文或归档取数——归档正文里的数字是**当时**的快照。

> **追加协议（2026-10-29 起）**：一次施工收口后，本文件**只追加两样东西**——
> ① 索引表末尾加一行（编号 / 日期 / 一句话结论 / 详情落点）；
> ② 若有未决策项，追加到文末未决策面（当前是 §96.41「未动项清单（需决策 / 需另开单）」）；
> 并把 §1 表里对应的 `[ ]` 改成 `[x]`。
> **编号由 main 分配**：分支与并行会话**不要**在 `PROGRESS.md` 自增 §号——2026-10-29 实测
> `mobile-ui-fix-01` 自拟的 §96.40 已与 main 的 §96.40 撞号。各单正文一律先写进
> `docs/evidence/<YYYY-MM-DD>-<slug>/`（本仓已在用的约定），合入 main 时再领取索引行与编号。
> 合并提示：`imgw-line` 改的是 §1 表「IM 网关与桌面端」那一行，该行现已回到本文件——
> 冲突时取分支侧那一行，不要整篇 `--theirs`（那会把 5,700 余行历史重新塞回本文件）。
> 纪律不变：**一次只推进一个阶段，验收通过才进下一阶段**（底座提示词 README §2.1）。

> 本次重排实测：本文件 **352 行**、归档 **5962 行**、索引 **126 条**（修正明细见 `docs/evidence/2026-10-29-progress-slim/01-adversarial-review.md`）。

## 1. 文档 / 施工单进度（19 行）

| # | 文档 | 对应阶段 | 状态 | 备注 |
|---|---|---|---|---|
| 00 | 全局约定与工程纪律 | 全程（宪法） | [x] | 落为 `AGENTS.md`；合规五条进门禁 `no-upstream-imports` |
| 01 | 仓库骨架与基建 | 阶段 1 · M0 | [x] | 见 §3 出口清单 |
| 02 | 内核 core | 阶段 2 · M1 | [x] | 内核已实装；出口清单见 §5，偏差见 §6 |
| 03 | 会话日志与工具管线 | 阶段 3 · M1 | [x] | 会话日志 + JSONL 后端 + 七段管线；出口清单见 §8，偏差见 §9 |
| 04 | 主循环 agent-loop | 阶段 5 | [x] | turn/step 状态机 + 四接缝 + 回退分叉；出口清单见 §14，偏差见 §15 |
| 05 | 模型层与提示词装配 | 阶段 4 | [x] | 词汇表 + Adapter seam + 六段装配 + reconcile + 压缩；出口清单见 §11，偏差见 §12 |
| 06 | 组合系统 profile | 阶段 6 | [x] | 三层概念（profile/bundle/patch）+ 四层层序 + config-only HMR + CLI 出口；出口清单见 §17，偏差见 §18 |
| 07 | 仿真银行 bank | 插件线 | [x] | bank-core / bank-forge 实装：九实体、票据状态机与原子核销、四档造数（含场景 5 的 recurring）、风控预检五规则；出口清单见 §26，偏差见 §27，待确认见 §28 |
| 08 | 银行工具族 | 插件线 | [x] | 19 个银行工具（W03 增 2、场景 5 增 3，现 19 个）/ 三级判决与票据桥接 / presenter 契约 / 目录门禁 / headless 实跑；出口清单见 §29，偏差见 §30，待确认见 §31 |
| 09 | 三级权限审批票据 | 插件线 | [x] | 判定矩阵 + 五条附加规则 / `@bah/interaction` 审批服务与票据账本 / 身份绑定渠道 / 红级挑战链 / headless 幕 3；出口清单见 §32，偏差见 §33，待确认见 §34 |
| 10 | 安全防护层 sentry | 插件线 | [x] | **批次 A+B 已交付**：内核七件 + 89 用例（§38，偏差 R119–R126）；四接缝接线 / 注入矩阵五攻击面 / 幻觉防护四机制 / 熔断锁存与显式解冻 / 宿主行 `safety:sentry`（§40，偏差 R127–R135） |
| 11 | 沙箱运行时 | 插件线 | [x] | `sandbox-policy` + `sandbox-runtime` 已落地（档位/硬杀/三态失败/门禁，见 §36）；宿主行 `safety:sandbox` 已接 `analysis_calc`（`BANK_COMPUTE` seam，2026-10-20） |
| 12 | 审计轨迹与回放测试 | 阶段 7（建议项） | [x] | **仅 test-support 节选**（快照录制回放 + 确定性）；TraceLog / 报表 / 对抗用例库属插件线；出口清单见 §20，偏差见 §21 |
| 13 | Web 前端 | 插件线 | [x] | 渠道抽象 `ChannelAdapter` + 帧投影 + 五视图（对话/三态卡/审批/DAG/审计）+ `channel:web` 插件行；出口清单见 §45，偏差见 §45.2 |
| 14 | 移动 H5 与跨场景规划 | 插件线 | [ ] | |
| 15 | IM 网关与桌面端 | 插件线 | [ ] | `apps/im-gateway`、`apps/desktop` 占位 |
| 16 | 交付材料与验收 | 插件线 | [ ] | |
| — | 底座收口（R44/R46/压缩 + 快照工具链） | 阶段 8 | [x] | 事件顺序按施单重排、判停独立成 `guard-stopped`、压缩前移到请求装配前、JSONL 编解码下沉 util、`pnpm snapshot:record`、快照门禁；出口清单见 §23，偏差见 §24 |
| — | 一致性检查（文档 ↔ 代码） | 每阶段末 | [ ] | 阶段 1 已做：api.ts ↔ 02/03 逐条对照，见 §4 |

## 索引 · 历史台账（§2 ～ §96.36，正文在归档文件里）

> 排序＝**归档内的文件顺序**（时间序），不是编号顺序：源台账把 §96.9 写在 §96.7 之前、
> §96.27 存在重号，此处**原样保留不重排**。行区间是归档文件的实际行号，含该节最后一条内容。

| 编号与标题（原样） | 归档内行区间 |
|---|---|
| 2. U3 · 人力裁剪决议（施工单 01 出口标准第 7 条） | L30 – L41 |
| 3. 阶段 1 出口清单（施工单 01 §0 + §9） | L42 – L64 |
| 4. 已知偏差与残留风险（阶段 1） | L65 – L77 |
| 5. 阶段 2 出口清单（施工单 02 §0 + §11） | L78 – L94 |
| 6. 已知偏差与残留风险（阶段 2） | L95 – L112 |
| 7. 测试地基（阶段 2 追加，按人工要求「把测试框架详细补上」） | L113 – L139 |
| 8. 阶段 3 出口清单（施工单 03 §0 + §5） | L140 – L157 |
| 9. 已知偏差与残留风险（阶段 3） | L158 – L171 |
| 10. 阶段 3 残留风险闭环（人工要求「残留风险解决」） | L172 – L180 |
| 11. 阶段 4 出口清单（施工单 05 §0 + §8） | L181 – L218 |
| 12. 已知偏差与残留风险（阶段 4） | L219 – L231 |
| 13. 阶段 4 待人工确认项 | L232 – L240 |
| 14. 阶段 5 出口清单（施工单 04 §0 + §8） | L241 – L281 |
| 15. 已知偏差与残留风险（阶段 5） | L282 – L297 |
| 16. 阶段 5 待人工确认项 | L298 – L307 |
| 17. 阶段 6 出口清单（施工单 06 §0 + §7） | L308 – L355 |
| 18. 已知偏差与残留风险（阶段 6） | L356 – L369 |
| 19. 阶段 6 待人工确认项 | L370 – L380 |
| 20. 阶段 7 出口清单（施工单 12 · test-support 节选） | L381 – L410 |
| 21. 已知偏差与残留风险（阶段 7） | L411 – L422 |
| 22. 阶段 7 待人工确认项 | L423 – L432 |
| 23. 阶段 8 出口清单（底座收口：R44/R46/压缩 + 快照工具链） | L433 – L450 |
| 24. 已知偏差与残留风险（阶段 8） | L451 – L464 |
| 25. 阶段 8 待人工确认项 | L465 – L474 |
| 26. 插件线 07 出口清单（施工单 07 · 仿真银行 bank） | L475 – L504 |
| 27. 已知偏差与残留风险（插件线 07） | L505 – L518 |
| 28. 插件线 07 待人工确认项 | L519 – L529 |
| 29. 插件线 08 出口清单（施工单 08 · 银行工具族） | L530 – L572 |
| 30. 已知偏差与残留风险（插件线 08） | L573 – L592 |
| 31. 插件线 08 拍板记录（2026-10-19） | L593 – L604 |
| 32. 插件线 09 出口清单（施工单 09 · 三级权限审批票据） | L605 – L625 |
| 33. 已知偏差与残留风险（插件线 09） | L626 – L641 |
| 34. 插件线 09 待人工确认项 | L642 – L652 |
| 35. 插件线 09 测试落点与配置/事件表 | L653 – L739 |
| 36. 施工单 11 出口清单（沙箱运行时 · `sandbox-policy` / `sandbox-runtime`） | L740 – L771 |
| 37. 已知偏差与残留风险（施工单 11） | L772 – L782 |
| 38. 施工单 10 · 批次 A 出口清单（sentry 内核八件，`packages/safety/src/sentry/kernel/`） | L783 – L811 |
| 39. 插件线 09 收尾拍板（2026-10-19，引导式提问） | L812 – L827 |
| 40. 施工单 10 · 批次 B 出口清单（四接缝 / 注入矩阵 / 幻觉防护 / 熔断锁存 / 宿主行） | L828 – L978 |
| 41. 知识平面 RAG sidecar 骨架（2026-10-19） | L979 – L998 |
| 42. 2026-10-20 复核决议与落地（R131 / 只绿边界 / XSC / trace） | L999 – L1012 |
| 43. 2026-10-21 修复决议与 QuickJS 延后 | L1013 – L1043 |
| 44. 2026-10-21 阶段 A 施工回执（门禁全绿） | L1044 – L1099 |
| 45. 插件线 13 出口清单（施工单 13 · Web 前端） | L1100 – L1178 |
| 46. 2026-10-21 门禁扩容 07 施工回执（16 → 23 项） | L1179 – L1226 |
| 47. 2026-10-21 sandbox-compute 快照场景施工回执（R141 的沙箱/forge/verify 背书） | L1227 – L1277 |
| 48. 2026-10-21 施工单 16 施工回执（`bah audit` 接入） | L1278 – L1322 |
| 49. 2026-10-23 施工单 HP-0 施工回执（sentry 判决件 fail-closed + 人工解冻入口） | L1323 – L1373 |
| 50. 2026-10-24 安全自评 + fail-injection 演示（R-04 结清） | L1374 – L1415 |
| 51. 2026-10-24 P0-1 收口 + 部署说明 + HP 口径写死 | L1416 – L1490 |
| 52. 2026-10-24 `plan:dag` v1 落地 + 收口四件 | L1491 – L1547 |
| 53. 2026-10-25 W01 施工回执（预检与基线冻结） | L1548 – L1587 |
| 54. 2026-10-25 容量裁决：走路 B（保范围），但 17 FTE 不成立 | L1588 – L1626 |
| 55. 2026-10-25 定档 T4：17 人 / 81 人日 / 17 单 | L1627 – L1674 |
| 56. 2026-10-25 W02 施工回执（三件冻结） | L1675 – L1727 |
| 57. 2026-10-25 W02 自审 + W03 阶段一（校验器） | L1728 – L1787 |
| 58. 2026-10-25 W03 阶段二（契约注册表 + 两个校验点已通电） | L1788 – L1847 |
| 59. 2026-10-25 W03 阶段三（校验已通电：宿主提供契约） | L1848 – L1907 |
| 60. 2026-10-25 W03 阶段四（14 份出参契约全部落地） | L1908 – L1988 |
| 61. 2026-10-25 W03 阶段五（ADR-0003 落地：事件表 17 → 19，工具 14 → 16） | L1989 – L2046 |
| 62. 2026-10-25 W03 阶段六（快照漂移定性为预期变化 → 重录） | L2047 – L2099 |
| 63. 2026-10-25 W03 收口（TC-02/05/06 + 两份文档） | L2100 – L2164 |
| 64. 2026-10-25 W04 施工回执（审批鉴权 + PolicyEngine） | L2165 – L2253 |
| 65. W07 · HALT 闭环（HP-3）收口（2026-10-25） | L2254 – L2447 |
| 66. W08 · 审计信封 v2 + 判决入链收口（2026-10-25） | L2448 – L2591 |
| 67. W09 · 强验证 Provider + riskScore 判决 + CSRF 收口（2026-10-25） | L2592 – L2710 |
| 68. W16 · `web.ts` 拆分收口（2026-10-25） | L2711 – L2872 |
| 69. W10 · `plan` 断点续跑（resume）收口（2026-10-25） | L2873 – L3019 |
| 70. W11 · plan P2 三项（`incident` / `node-waiting` / 动态 args）（2026-10-26） | L3020 – L3133 |
| 71. 2026-10-26 W12 开工裁决（票据 lease + saga 补偿回读） | L3134 – L3193 |
| 72. 2026-10-26 W12 施工回执（票据 lease + saga 补偿回读） | L3194 – L3269 |
| 73. 2026-10-26 W12 双角度复审（验收契约 + 对抗/回归） | L3270 – L3319 |
| 74. 2026-10-26 W05 施工回执（断言核验门 / `safety:verify`） | L3320 – L3399 |
| 75. 2026-10-26 W05 双角度复审 | L3400 – L3440 |
| 76. 2026-10-26 W06 施工回执（权威知识库签名门） | L3441 – L3538 |
| 77. 2026-10-26 W06 双角度复审 | L3539 – L3582 |
| 78. 2026-10-26 W13 施工回执（eval 60 场景 + 四项指标） | L3583 – L3681 |
| 79. 2026-10-26 W13 双角度复审 | L3682 – L3725 |
| 80. 2026-10-26 W14 施工回执（对抗集 45 例） | L3726 – L3798 |
| 81. 2026-10-26 W14 双角度复审 | L3799 – L3837 |
| 82. 2026-10-26 W15 施工回执（独立重放 + 监管材料 + 基线 + CI） | L3838 – L3926 |
| 83. 2026-10-26 W15 双角度复审 | L3927 – L3969 |
| 84. 2026-10-26 W05–W15 全量复审（逐条复算 + 4 处修正） | L3970 – L4048 |
| 85. 2026-10-26 W18 第一步回执（web 投影器接线：定位到 session 广播重入） | L4049 – L4167 |
| 86. 2026-10-26 W18 第一步双角度复审 | L4168 – L4209 |
| 87. 2026-10-26 W19 施工回执（架构图 + 核心算法 + 安全设计） | L4210 – L4315 |
| 88. 2026-10-26 W19 双角度复审 | L4316 – L4370 |
| 89. 2026-10-26 W17 施工回执（覆盖率分母 + 三条门禁 + 类型收紧） | L4371 – L4461 |
| 90. 2026-10-26 W17 双角度复审 | L4462 – L4500 |
| 91. 2026-10-26 整体提交 + 一条已知红（`snapshot-fresh`） | L4501 – L4549 |
| 92. 2026-10-26 W20-0 施工回执（`snapshot-fresh` 关红） | L4550 – L4659 |
| 93. 2026-10-26 W20-0 双角度复审 | L4660 – L4697 |
| 94. 2026-10-26 W20 施工回执（演练材料四件） | L4698 – L4784 |
| 95. 2026-10-26 W20 双角度复审（演练材料） | L4785 – L4821 |
| 96.1 2026-10-26 C01 发布基线（本地收口，远端推送待凭证） | L4822 – L4855 |
| 96.2 2026-10-27 C02 口径纠错（HP-4 已实现，不再列为缺口） | L4856 – L4890 |
| 96.9 2026-10-27 C09 取证日志（W05/W06 引用改为可入库路径） | L4891 – L4923 |
| 96.7 2026-10-27 C07 数字归一 + `verify-facts` 门禁（门禁 35/35） | L4924 – L4973 |
| 96.10 2026-10-27 §5.1 压缩摘要修复 + 双角度复审 | L4974 – L5027 |
| 96.11 2026-10-27 PROGRESS 核实更新（不采信自述，按命令输出对账） | L5028 – L5071 |
| 96.12 2026-10-27 缺口 §5.2 修复（token 水位口径） | L5072 – L5126 |
| 96.13 2026-10-27 缺口 §5.3 修复（知识健康检查静默） | L5127 – L5186 |
| 96.14 2026-10-27 C04 判据一：Web 演示关闭逐条 fsync（B1） | L5187 – L5211 |
| 96.15 2026-10-27 C04 判据二：429 / 5xx 同模型退避（B2） | L5212 – L5246 |
| 96.16 2026-10-27 C04 判据三：Web 拒绝分支判红（B3） | L5247 – L5279 |
| 96.17 2026-10-27 A3：usage 补缓存命中与成本（微元） | L5280 – L5312 |
| 96.18 2026-10-27 A7：deepseek 网络路径的快照背书 | L5313 – L5342 |
| 96.19 2026-10-27 A8：`--dump-config` 零网络（探活开关） | L5343 – L5373 |
| 96.20 2026-10-27 D1：公开材料数字归一 | L5374 – L5404 |
| 96.21 2026-10-27 D2：评委走查表（C10） | L5405 – L5435 |
| 96.22 2026-10-27 D3：10-28 答疑出战包（C03） | L5436 – L5462 |
| 96.23 2026-10-27 D4：施工文档集 44 份统一废弃横幅 | L5463 – L5490 |
| 96.24 2026-10-27 D5：缺口报告自身基准更新 | L5491 – L5521 |
| 96.25 2026-10-27 C03 未闭合项收口：种子日限额对齐 1000 元 | L5522 – L5549 |
| 96.26 2026-10-27 C03 未闭合项收口：单容器 Web Dockerfile | L5550 – L5580 |
| 96.27 C 类收口：门禁质量 / HALT 持久化 / 记忆接线 / 人工接管 / 文档一致性（2026-10-27） | L5581 – L5662 |
| 96.27 2026-10-27 M4：边界口径统一与仓库卫生（赛前收口清单 §6） | L5663 – L5707 |
| 96.28 2026-10-28 策略外置 S1：语言、编译器与求值器（`@bah/policy`） | L5708 – L5751 |
| 96.29 2026-10-28 策略外置 S4：4 条门禁、负例、policy-externalized 快照 | L5752 – L5810 |
| 96.30 2026-10-28 策略外置 S4 第二轮复审：demo 激活加固、min 边界与第一性原理审查 | L5811 – L5854 |
| 96.31 交付面 P1 闭合：覆盖率门禁与事实台账（2026-10-28 20:15） | L5855 – L5876 |
| 96.32 S5：sentry.rules 第二类 bundle（2026-10-28 21:2x） | L5877 – L5893 |
| 96.33 生产 Ed25519 密钥流程落地（2026-10-28 21:5x） | L5894 – L5903 |
| 96.34 S6：A/B 复审与证据包（2026-10-28 22:0x） | L5904 – L5915 |
| 96.35 移动 H5 · 01 渠道底座与宿主装配（2026-10-29） | L5916 – L5936 |
| 96.36 移动 H5 · 02 移动壳与交互面（2026-10-29） | L5937 – L5962 |

---

## 96.37 赛前状态盘点（2026-10-29，不改代码）

- **范围**：只盘点不改码。产出物在**仓库外**——`BAH-未完成清单-2026-10-29.md`（取代同日 10-28 那份，
  后者已移入 `文档归档/`）。本轮**未跑任何测试或门禁**：工作树脏 48 项、并行「可观测性」线在写，
  跑出来的数不属于任何一条线；因此本节所有数字要么标"实测"（git/grep 亲验），要么标明引自 `facts.md`/PROGRESS。
- **当天漂移**（同一工作树，间隔 3 小时）：HEAD `04de7f1`（11:11）→ `bff324c`（14:27）；
  `pnpm gate` 44/44 → **45/45**；`test:web` 12 文件/139 例 → **22 文件/333 例**（§96.36）；
  未推提交 28 → **30**。结论：**任何写死绝对值的清单当天就会过期**，判活只认 `git log` + `ls scripts/verify-*.ts | wc -l`。
- **补登两条 PROGRESS 一直缺的已完成项**（代码在 main 里，日志里没有，后人只能重新调查）：
  1. `fe3f833` 端口绑定避开 Fetch 禁用端口。**真因不是 `server.address()` 回落**：本机 Windows 动态端口范围
     1024–15000 里有 16 个属 WHATWG Fetch 禁用端口（2049/3659/4045/4190/5060/5061/6000/6566/6665–6669/6679/6697/10080），
     `port: 0` 偶尔分到它们 → 服务正常 `listen`、`fetch` 在连接前抛 `bad port`（每轮约 60 次绑定 × 16/13977 ≈ 6.9%，
     与"1/5–1/30 随机"吻合）。修法三条硬约束见 `web/listen.ts`：`FETCH_BAD_PORTS` + 关闭重绑最多 8 次、
     拿不到真实端口即抛 `web-listen-failed`（**不回退配置端口**）、显式端口命中禁用表 fail-loud 不偷偷换。
     ⚠️ 10-27/10-28 两份报告写的"有界重试无效、正解是断言 `boundPort>0`"**只对一半**：对同一个 `:0` 反复解析确实无效，
     但对 OS 随机名额，重绑换名额正是正解。归因来源是仓库外 `文档归档/BAH-门禁与稳定性完成与复审-2026-10-28.md`。
  2. `360f6d6` 供应链 action 锁 SHA。本轮 `grep 'uses: ' .github/workflows/*.yml` 实测 **23 处全部 40 位 SHA、0 处未锁**
     （10-28 清单登记的"5 处未锁"已作废）。
- **合流缺口（本轮最大的"做完了但看不见"）**：`git worktree list` 6 份检出，main 不含以下两条线：
  - 人机接管 `handoff-01-core` `7806e51` + `handoff-02-workbench` `9659006`（base `bbb7a80`，main 之后又走 5 个提交；
    分支改 59 文件、与 main 重叠 **23** 个、`git merge-tree` 冲突标记 **33** 处）；
  - 租户与鉴权 `tenant-01…04`（`dc26952`/`2285796`/`be9426b`/`529a851`，base `6af6d64`，main 之后 4 个提交；
    分支改 199 文件、重叠 **41** 个、冲突标记 **45** 处）。
  - 合流必做的收尾：重灾区 `plugins/web.ts` + `web/{config,router,dispatch}.ts` + `web/handlers/metrics.ts`
    两边都插了闸，要逐处判"两条都要"；派生文件重算（`snapshots/*`、`assertion-baseline.json`、`facts.md` 与
    `docs/facts-sources.md` 必须同批，否则 `verify-docs-consistency` 钉回旧数）；`/api/trace` 无 roles →
    合并后 `verify-authz-coverage` 会红；**三份 PROGRESS 节号已撞**（main 的 §96.35/§96.36 = 移动 H5 01/02，
    `TENANT-04-WT` 的 §96.35 = 租户 01，`HANDOFF-02-WT` 的 §96.36 = 接管 02），合回同一文件必须重排号。
- **赛题硬性项缺口（§五）**：答辩 PPT 与演示视频**仍 0 成品**（全工作区 `.pptx` = 0；`.mp4` 只有
  `.tmp-w18/probe/` 四个录屏探针，`.ppt` 只有第三方夹具 `preview.ppt`）；演示目录 docs/demo 不存在；
  仓库外 `赛事规则/10.28线上答疑-问题清单-…-草案.md` §4 答案回填表 A1–A9/B1–B6 **逐格空白**、文件状态仍是"草案"，
  而其 §5 要求会后 24h 内回填（到期日即 10-29）。部署说明/安全自评/技术文档/简介四项已具备（10-23 清单的
  "❌ 无 deploy.md""⚠️ 自评只覆盖 audit 插件"两条判断作废）。
- **推送面一处待澄清的矛盾**：`文档归档/BAH-门禁与稳定性完成与复审-2026-10-28.md` 称"远端 `main` 与
  `v1.0-submit` 都指向 `c7a25ab`"，但本地 `refs/remotes/origin/main` 只到 `ad9dc53`（12:09，比 `c7a25ab` 早 32 分钟）。
  本轮两次 `git ls-remote` 均在 21s 后超时（`Failed to connect to github.com:443`）→ **远端真实头无法核实，推送动作当前被网络挡住**。
  网络恢复后第一件事就是核这两个 ref，再看 `ci.yml` 徽章（`check:ci` 全 14 步含 coverage、严格模式不接受 SKIP，
  未配 `DEEPSEEK_API_KEY` secret 时 `test:e2e` 判红）。
- **口径**：可以说"端口随机红已按真因消除、23 处 action 全锁 SHA、实体槽位/策略外置/可观测性/移动 01+02 已入 main"；
  **不能**说"多租户已实现""坐席工作台已交付"（两条线在分支、main clone 不到）、"生产已切 sentry 外置规则"
  （`rules.engine` 默认 legacy、profiles 未切）、"策略文件防篡改"（生产签名 overlay 未启用）、
  "覆盖率台账已刷新"（`docs/coverage-baseline.json` 只认 CI 口径，PE-46 待 CI 跑批）、"交付材料齐了"（PPT/视频 0 成品）。
- **本轮未验**：`pnpm check` / `gate` / `vitest` 均未跑；§96.35/§96.36 与两条分支的测试数取自各自 PROGRESS，
  **未在合并后的树上复现**；冲突标记数是 `git merge-tree` 静态计数，没真做过一次合并试算。

## 96.38 2026-10-29 收口：可观测性线 + 移动 H5 04 提交、门禁四红解除

- **三笔提交**（同工作树多线并行，分笔提交；均走 pre-commit，未用 `--no-verify`）：
  - `19d05f1` feat(obs)：可观测性线收口——观测 tab / observability 客户端 / metrics·trace·cost CLI /
    SSE 手动续订 / UI 修正，51 文件；
  - `7f34320` feat(runtime)：移动 H5 04 单施工——goal/todo 平面、`POST /api/session/fork`、
    cross-scene 快照与门禁，95 文件；
  - `0ac51ba` docs(evidence)：04 单复审报告与 SHA256SUMS。
- **门禁四红 → 47/47**（`pnpm gate` 4/47 红 → 47/47，证据 `docs/evidence/2026-10-28-mobile-h5/04-gate-final.txt`）：
  - `assertions`：并行线 `observe-http.test.ts` 24 条登记进基线（8872 条 / 278 文件）；
  - `tracked-sources`：并行线测试随 `19d05f1` 入库；本单未跟踪源码 `git add -N` 后随本单入库，现未跟踪源码 0；
  - `snapshot-fresh`：`packages/saga/src/gates/` 计入 `snapshots/web-channel/scenario.json` 的
    `coveredSources` 并 `pnpm snapshot:reverify`（`6af6d64` 是纯搬移）；`snapshots/cross-scene/` 先
    `git add -N`，门禁才看得见 `reverified.json`；
  - `docs-paths`：§96.37 的 docs/demo/ 引用改为非代码跨度（避免被当路径检查）。
- **共享文件分离**：`apps/web/src/transport.js`、`scripts/verify-docs-consistency.ts`、
  `docs/web-frontend.md`、`scripts/assertion-baseline.json` 两线改动已分笔；复核方式
  `git show <hash> -- <file>`，两笔提交互不含对方文件。
- **验证口径（如实）**：本轮未重跑 `pnpm test`；264 文件 / 3047 例等数字引自 04 施工批
  （web 23/338、snapshot 9/39、eval:unit 22/158）。本次实跑 `snapshot:reverify`
  （9 文件 / 39 例全过）与 `pnpm gate` 47/47；四个原红项另行单独复跑均 exit 0。
- **仍未闭合**：含本记录在内 `origin/main` 之后 **36** 个提交未推，远端可达性未核（此前两次
  `git ls-remote` 21s 超时）；赛题 PPT / 演示视频仍 0 成品；`test:e2e` 无 key、`pnpm check` 未整体跑。
- **口径更正**：§96.37 的"工作树脏 48 项 / 未推 28–30 / HEAD 04de7f1"是 14:32 的时点值，
  已被本节取代；docs/demo 目录仍不存在（赛题演示材料未产出）。

## 96.39 2026-10-29 人机接管 01+02 合流（施工单 01）

- **分支**：`integration/handoff-tenant`（自 `11f0eb3` 开出），`git merge --no-ff --no-commit handoff-02-workbench`（`9659006`，merge base `bbb7a80`）。`main` 未动；备份 tag `pre-merge-2026-10-29` + bundle `../bah-pre-merge-2026-10-29.bundle`。
- **冲突 22 个，与施工单预期一致**。关键三处：
  1. `web.ts` 取 main（60 行），handoff 增量全部搬进 `web/channel.ts`（`readOperatorConfig`、`createHandoff({files, slaMs})`、`operatorEntry`、`seatEnabled`）；
  2. `dispatch.ts` / `router.ts` 并集：main 的 `trace`/`fork` 与 handoff 的 4 条坐席路由同表，路由 **23 条**；
  3. 文档类全取 main 版，只有 `docs/web-frontend.md` §7 按 `web-routes.ts` 重生成。
- **超出纯合并的六处修正**：
  - `handoff-store` 构造参数改 `file`；`createHandoff` 用 `dirname(SessionFiles.fileOf(sid))` 推导，不再自己拼 `root/sessionId`；
  - `static.ts` 坐席判定改 `deps.seatEnabled`；`operator.html` 即便误配进 `entries` 也不注入 token（第二层硬排除）；
  - `verify-web.ts` 改**逐入口**声明样式（index/operator → `app.css`，`m.html` → `mobile.css`），未登记 `.html` 判红；
  - `demo-handoff.ts` 的 `session.jsonl` 改由 `SESSION_FILES.fileOf` 推导；
  - 接管指标派生拆到 `handlers/metrics-handoff.ts`，`metrics.ts` 221 → 187 行（handler < 200 行结构预算）；
  - `mobile.test.ts` / `channel.test.ts` 补 `SESSION_FILES`（两渠道共用装配 ⇒ 都要求会话根）；`metrics.test.ts` 补 `handoff` 桩。
- **验证（实跑）**：`typecheck` / `lint` 绿；`pnpm test` **266 文件 / 3100 例**；`pnpm test:web` **27 文件 / 361 例**；`pnpm gate` **47/47**（18:19 那次）；`pnpm handoff:demo` 闭环通过；`verify-web` 正反自检 **5/5**；`handoff.json` 落盘接线探针 **7/7**。断言基线 8872 → 9033 条 / 280 文件（`--update`，只增不减）。
- **提交用 `--no-verify` 的原因（如实）**：18:20 起工作树出现两份**非本单产出**的未跟踪测试（`handlers/handoff-message.test.ts`、`handlers/metrics-handoff.test.ts`，19 例全过），使当前工作树的 `tracked-sources` 与 `assertions` 判红。按用户决定不替其作者提交；提交树不含这两个文件（干净 clone 上两门禁为绿），两份文件留在工作树等作者入库。
- **证据**：`docs/evidence/2026-10-29-integration/`（合并说明 + 四份原始日志 + 自检日志）。
- **仍未闭合（交施工单 02）**：鉴权仍是临时 `user`/`operator`（客户 token 打坐席 API 是 401 不是 403）；password 模式未涉及；`facts.md` 未重算（3047 → 3100，统一留给 02）；6 张人工截图未做；未推送、未动 tag。

## 96.40 2026-10-29 合流：人机接管 01+02 + 租户与鉴权 01–04

> 编号说明：96.39 已被施工单 01 占用，历史不重排；本节是施工单 02 的收口记录。

### 96.40.1 人机接管合入

- `tenant-04-delivery` 的 05 回归审查已先落一笔（`44f552e`，23 文件 / +337−85，tenant 线自跑 gate 44/44、eval 158/158）。
- `integration/handoff-tenant` 上 `git merge --no-ff --no-commit tenant-04-delivery`：**17 个冲突**（施工单 02 预期 30 个，合完 handoff 后实际数量变化，以列表为准）。
- 冲突处理原则：`web.ts` 整文件取 main 并把 tenant 的 auth 增量搬进 `web/channel.ts`；`router.ts` 以 tenant 的 `RouteSpec + roles` 为主并保留 main 的 `trace`/`fork` 与 5 条接管路由；快照 `reverified.json` 一律取 main 后由 `snapshot:reverify` 重算。

### 96.40.2 租户与鉴权合入（含 05 回归审查）

- `channel.ts` 接入 `createWebAuthRuntime`（会话存储 / 口令目录 / 节流 / 审计）与 `wireWebPipelines`（①②③ 三条管线只保留一份实现，web/mobile 不再分叉）；`deps.tenantId = run.tenantId`、`deps.tryAudit` 补齐。
- 语义冲突五处（合流后新暴露、均已修）：
  1. `handoff-store` 的 `HandoffSnapshot` 旧 `operator` 字符串 → `operatorId` / `operatorLabel` / `requestedBy`；
  2. `audit-decisions.verifyAll` 的租户对账把截断告警吞掉 → 恢复 `host.audit-write-failed` 结构化日志；
  3. `intent.test` 的 `bah:memory-store` 旧配置（`tenant` 键 + `:memory:` + `sessions/memory.db`）→ 租户根下的单段文件名，并补 `core:persistence`；
  4. `audit-decisions.test` 的链目录补租户段（`<root>/demo/<sid>/audit.jsonl`）；
  5. `mobile` patch 的 `bah:memory-store` 跟上新 schema（I8 两渠道配置一致）。

### 96.40.3 身份平面统一与路由角色（static 双凭证 / 17 行矩阵）

- `static` 双凭证：`BAH_WEB_TOKEN` → `svc:web` / `customer`，`BAH_OPERATOR_TOKEN` → `svc:operator` / `agent`；两 token 相同 boot 期拒绝（`web-operator-token-conflict`）。临时的 `presentedPrincipal` / `auth:'user'|'operator'` 删除。
- `none` 主体收窄为 `['customer']`（不含 agent）：否则无凭证请求能打坐席 API。
- 26 条路由：客户专属（turn / interrupt / approval / verify → `customer`）、fork（customer/admin）、trace（D4 暂按 ROLES）、坐席四动作（agent/admin）、queue（agent/auditor/admin）。
- 越权矩阵 11 → **17 行（68 格）**；`verify-authz-coverage` 双向覆盖 0 findings。
- password 模式的坐席登录本轮不做（D2）：`SEAT_PASSWORD_LOGIN=false` ⇒ `/operator` 与 5 条坐席 API 在 password 模式一律 404（在身份解析前判，不暴露存在性）。

### 96.40.4 验证与证据

- `pnpm typecheck` / `pnpm lint` / `pnpm build` 绿。
- `pnpm test` **294 文件 / 3333 例**；`pnpm test:web` **27 文件 / 365 例**；`pnpm test:snapshot` **9 文件 / 39 例**；`pnpm eval:unit` **22 文件 / 158 例**。
- `pnpm gate` **50/50**；`tenant-matrix` **8/8**；`verify-tenant-scope` 6 坏样本全抓 / 4 合法不误报；`verify-tenant-isolation` 4 坏样本全抓 / 3 合法不误报；`pnpm handoff:demo` 闭环通过。
- 证据目录 `docs/evidence/2026-10-29-integration/`（本单新增 02–09 与 `SHA256SUMS`）。

### 96.40.5 边界与未做

- 一进程 N 租户、OS 级隔离、RAG 信封签名、外部锚定、retention、semver 门禁仍不做。
- password 模式的坐席前端（登录卡片复用 / cookie + CSRF 的 seat API / SSE cookie）未做（D2 降级项）。
- `/api/trace` 仍是 `ROLES`（D4 降级项）：生产应收窄到 auditor/admin，自评列为残余风险。
- 6 张人工截图未做；推送与 tag 未动。

---

## 96.41 2026-10-29 桌面 Web 走查修复 · 未动项与待决策

> 依据 `BAH-Web界面逐屏走查报告-2026-10-29.md`：P0 ×2（含 §1.3 同根因）与 P1 ×6 已闭环，
> P2 已修 7 项（P2-1…P2-7）；复审期间另修 2 项（会话控制端点 401 收敛、转人工成功后被无关帧
> 重新点亮）。**本节只记"没动的东西"**，避免下一轮把待决策当成已完成。
> 本轮验证：`pnpm test:web` 27 文件 / 375 例、`pnpm test` 295 文件 / 3349 例、
> `pnpm typecheck` / `pnpm lint` 绿、`pnpm gate` 50/50。代码改动**尚未提交**，且工作树里
> 混有另一并行任务的租户测试改动（未触碰）。

### 96.41.1 未动项清单（需决策 / 需另开单）

| # | 条目 | 现状（实测 / 代码口径） | 为什么没动 | 需要的决策 / 下一步 |
|---|---|---|---|---|
| 1 | P2-8 对比度 36 处、P2-9 92 个 <12px 文本 | 走查实测：`ds-tag--success` 2.52、审计分类「安全」3.08×9、tab 4.35、`audit__time/seq` 4.35@10px 等 | 根因在 DS 令牌（`design/bah-ds/colors_and_type.css` 与 `apps/web/styles/ds` 分发副本）；抬一档会影响三个壳与快照，报告明写"需要设计侧确认令牌值" | 设计侧确认后统一抬 `--body-xs/sm` 与 `--text-tertiary` 一档；同步分发副本并重录相关快照 |
| 2 | P2-10 password 模式 `/operator` 与 5 条坐席 API 整体 404 | `seatEnabled = channelId==='web' && (password ? SEAT_PASSWORD_LOGIN : operatorToken!=undefined)`；`SEAT_PASSWORD_LOGIN=false`（D2 降级项，见 §96.40.5） | 属"坐席怎么登录"的产品口径：复用客户会话按角色放行，还是单独坐席口令/凭证 | 产品 + 安全拍板认证方式；开 D2 后同时补 seat API 的 cookie/CSRF 面与 SSE 身份 |
| 3 | 移动壳同根因 P0：`mobile.css` 没有 `[hidden]` 兜底 | `.m-sheet-backdrop` 显式 `display:flex`；`approval-sheet.js` 用 `backdrop.hidden=true/false` 表达开关。关抽屉后遮罩仍占全屏、仍接指针（opacity 0 不挡命中测试） | 修复已在未合入的 `mobile-ui-fix-01`（`fb23eb6`：mobile.css 加 `[hidden]` + `verify-mobile-shell I12`）；在主树手抄会与该分支冲突 | 合并 `mobile-ui-fix-01`（推荐）；或在主树只补一行 `[hidden]{display:none!important}` 并写明随后合并会冲突 |
| 4 | 坐席台客户气泡 meta 仍是「你」 | `seat/views/thread.js` 复用 `views/conversation.js` 的 `renderMessage`；该函数对 `role:'user'` 一律写「你」。本次只给 `handoff-waiting` 加了「等待坐席处理」标签 | 属既有渲染器口径（坐席看到的是客户视角镜像）；彻底修要给渲染器加 viewer 参数，牵动客户/坐席/移动三处 | 另开单：`renderMessage(frame, { viewer })`，坐席视角「客户」、客户视角「你」；补对应用例 |
| 5 | P2-2 断线时发送按钮仍可点 | 已加断线横幅（「连接已断开，界面数据可能不是最新」）；`send.disabled` 不随 SSE 状态变化 | SSE 断开不等于 HTTP 不可用（代理可能只掐长连接）；按 SSE 状态禁用发送会误伤仍可提交的部署 | 若要禁：先确认部署口径（SSE 断开是否等价整站不可用）；否则维持现状，且文案不承诺"重连" |
| 6 | 真浏览器冒烟门禁未入库 | 报告建议：CDP 加载 `/operator` → 断言 `#seat-gate display==='none'` → 真实点「认领」；本轮用一次性探针（`temp/web-ui-audit/s9-fix-verify.mjs`）实跑通过 | CI 无 Edge 与服务端，做进 `pnpm gate` 会让干净检出即红；仓内 `pnpm test:web` 是 jsdom，判不出 `[hidden]` 与命中测试 | 二选一：新增 `smoke:web`（本地/演示专用，不进 pre-commit）；或保持人工探针并列为答辩前检查项 |

## 96.42 2026-10-29 PROGRESS.md 瘦身二轮（对抗式复审落地）

- 复审被打出 7 项缺陷（P0×2 / P1×2 / P2×2 / P3×1），逐条判据与处置见
  `docs/evidence/2026-10-29-progress-slim/01-adversarial-review.md`。审查者与被审者未分离。
- 本轮改动：§1 状态表回到当前面；§96.28–§96.36 逐字迁进归档（归档随之改名
  `docs/progress-archive-2026-10-18_28.md`）；索引行区间 off-by-one 修正（126 条，连续性有断言）；
  归档 21 处"搬家致断"的相对链接修正；追加协议补上**编号由 main 分配**。
- 未落库：`verify-doc-links` 门禁实测会逼 `npx tsx scripts/gen-architecture.ts` 重写三份
  生成文档，而那三份是并行会话**未提交**的文件 → 门禁暂存出场，等它们入库再上。
- 回归检查后的补记（同日）：4 处 `PROGRESS.md:<行号>` 式引用曾随瘦身悬空，已在原处标注新落点
  （`docs/release-baseline-2026-10-26.md` 引 §66、`docs/snapshot-sandbox-scenario-report.md` 引 §46、
  `docs/evidence/2026-10-28-mobile-h5/02-adversarial-review.md` 引 §96.36，原引用文本均保留）；
  `AGENTS.md` 的"27 项 / 10 步"改为实测 50 项 / 14 步并写明以 `facts.md` 为准。
- 接手口径改由 `docs/handoff-2026-10-29-progress-protocol.md` 承载（旧接手件的"补两节"已标废）。




## 96.43 2026-10-30 场景 5（订阅/代扣）P0–P9 施工收口

> 依据 `BAH-订阅代扣场景施工方案-2026-10-30/施工方案-订阅代扣全量.md`（v2）。
> 审查：主线程对抗式自审（**审查者与被审者未分离**），逐阶段报告在
> `docs/evidence/2026-10-30-sub-review/{P1-P3,P4,P5,P6,P7}.md`。

- **交付面**：工具 16→19（13 绿/4 黄/2 红）；事件 19→22（ADR-0007，已批准）；
  新增 `bank/src/detect/`（归一化 + 周期检测 + 断供核验，纯函数）；
  `recurring` 造数档（11 series / 9 high / 1 medium / 1 low / 1 duplicate）；
  `sub_cancel` 合约硬拦前移到 pre-execute（审批前拒绝）＋ 到期即断；
  【即将扣款】槽位（`contextSlots.subscriptions`，0 = 关闭）；
  离线路由补订阅意图；新增第 8 个快照场景 `snapshots/subscription`（10 文件 / 43 例）。
- **实测**：`pnpm test` 302 文件 / 3494 例；`pnpm test:web` 27 / 375；
  `pnpm eval:unit` 22 / 158；`pnpm test:snapshot` 10 / 43；`pnpm typecheck` / `pnpm lint` 绿；
  `verify-facts` / `verify-docs-consistency` / `verify-tool-catalog` / `verify-tiers` /
  `verify-session-events` / `verify-index-barrels` / `verify-intent-determinism` 绿。
- **检测指标**：`benchmarks/subscription-detection/`（合成标注集）＋
  `docs/evidence/2026-10-30-sub-detect/metrics.md`：high precision 100%、all recall 97.5%、
  kind 100%、下次扣款 ≤3 天 97.4%；2 条 FN 是只有 2 笔的系列（低于 3 笔下限）。
- **Web 实测（无可见浏览器，走 HTTP）**：`pnpm bah --profile web --serve --patch profiles/web/patch-subscription.yml`
  → `sub_list` 8/2/1、`sub_authorize` 审批后 affected=1、`sub_cancel` 合约硬拦**不弹审批**、
  `确认，到期即断` 审批后 `paused`。命令与话术见 `docs/evidence/2026-10-30-sub-review/P9-demo-script.md`。
- **未决策 / 待办**：
  1. **git 入库**：工作树含并行会话未提交文件（suitability / claims / eval U 场景 / host 鉴权等），
     本轮新增文件亦未跟踪。`verify-tracked-sources` 与 `verify-snapshot-fresh` 因未跟踪文件红，
     本轮未替他人 `git add`；需主会话统一分配提交面后再跑 `pnpm gate`。
  2. `verify-snapshot-fresh` 另报 `packages/saga/src/gates/index.ts` 无场景覆盖（属于并行线改动）。
  3. 推送与 tag 未动（本轮无提交）。
  4. 导出报表（沙箱落点）按方案 §1 登记为缺口，本期不做。

## 96.44 2026-10-29 移动 H5 走查修复（P0/P1/P2）与复审

> 编号说明：本节在 `mobile-ui-fix-01` 分支上原编号 96.40，与已合入的合流节撞号；合流时后置为 96.44，历史节不重排。

- **范围**：按 `BAH-移动H5界面走查报告-2026-10-29.md` 修复移动壳，全部在 `BAH/MOBILE-UI-WT`
  工作树（基线 `dd4aa75`），分支 `mobile-ui-fix-01`；主工作区 `BAH/MonoRepo` 仍在
  `integration/handoff-tenant` 的并行合并（17 个 `UU`），本轮**一行未动**。
- **三笔提交**（均走 pre-commit 的 `pnpm gate`，未用 `--no-verify`）：
  - `fb23eb6` fix(mobile-ui)：P0/P1/P2 主体修复，17 文件；
  - `d652bab` fix(mobile-ui)：复审补漏——`handoff-warn` 帧与三处 409 旧口径；
  - `ad2a640` test(mobile-ui)：补证——快照里的历史 handoff 帧不点亮横幅。
- **修复清单（对照走查报告）**：
  - P0-1：`packages/host/src/boot/plugins/web-auth.ts` 改为**先剥注释、再剥离同名 meta、
    按真实 head 结束标记注入**；`apps/web/m.html` 注释去掉 `</head>` 与凭证 meta 字面量；
    断言从“响应体 contains”改为“注释外必须存在真 meta 元素”，并加注释陷阱/多旧 meta 回归用例。
  - P0-2：`apps/web/styles/mobile.css` 增加 `[hidden] { display: none !important }` 兜底，
    一并消掉遮罩吞点击、中断钮常驻、空清单常驻、折叠体占位；`scripts/verify-mobile-shell.ts`
    增加 I12 防回归。
  - P1-1：移动壳删除“恢复”按钮与 `createSessionControlClient.resume`，横幅改为
    “消息会被记录；交回会话请在坐席工作台操作”。
  - P1-2：接管期 202 的 `accepted=queued-for-operator` 透传，composer 明示
    “消息已记录：人工接管期间不会驱动智能体”；`docs/mobile.md` 等同批改口径。
  - P1-3：空态判据由“容器子节点数”改为“已渲染条目数”，重复 `sync` 不再把空态卡自己删掉。
  - P1-4：补 `body { margin: 0 }`；整壳回到视口原点，`html.scrollHeight` 不再超一屏。
  - P2-1/P2-2/P2-5：chips 溢出时右缘渐隐 + scroll-snap；输入框 16px（防 iOS 聚焦整页放大）；
    `box-sizing: border-box` 修掉拒绝理由框右溢 5px 与抽屉超宽。
  - 复审新增：`handoff` / `handoff-warn` 帧不再渲染成“未知帧”；启动接管真相改由
    `GET /api/handoff` 给出、只认实时帧跃迁，交回时收起横幅并明说恢复；等待超时提示已等分钟数。
- **验证（实跑）**：`pnpm test` **268 文件 / 3122 例**；`pnpm test:web` **27 文件 / 366 例**；
  `pnpm typecheck` 0 error；`pnpm gate` **47/47**（三次提交各跑一遍）。真浏览器（Edge headless + CDP）：
  移动 390×844 下 meta 成元素、遮罩 `display:none`、发送钮命中测试落回按钮、空态可见、
  `body margin 0`、输入框 16px、chips 溢出渐隐；桌面 1440×900 注入正常、3 个标签页、0 条控制台错误；
  审批抽屉 open 态 `display:flex` 且批准钮命中（disabled 是手势闸）；接管期无恢复钮、发言得到入队提示。
- **仍未闭合 / 未在本轮修**（如实登记，按缺口不按结论收起）：
  1. **P1-5 dock 矮视口/横屏折叠**：未修。属结构改动，报告也建议演示冻结后再做；横屏 844×390
     实测 feed 可视高 **86px**（原 64px，仅因去掉 body margin 略增），仍放不下完整一条消息。
  2. **P1-6 “新会话/清会话”入口**：未修。宿主没有对应端点，移动壳无法只靠前端清掉跨进程复用的会话；
     需先在 host 侧提供能力并定下演示口径。
  3. **P2-3 / P2-4 对比度与 10–11px 小字**：未修。需设计侧确认 DS 令牌取值；
     `apps/web/styles/ds/` 两份副本受 sha256 门禁约束，不能单侧改。
  4. **P2-6 运行时上下文整段灌进窄屏会话流**：未修。属产品呈现决策（是否对终端用户隐藏内部上下文），
     不是前端能单方面决定的。
  5. **真浏览器 CDP 冒烟门禁**：未入库。CI 无 Edge，当前只有 DOM 级单测 + 手工 CDP 证据
     （探针与截图在仓库外、未入库）；报告建议的第 3 条因此只兑现了一半。
  6. **CRLF 环境问题**：未提交 `.gitattributes`。新 worktree / 新 clone 仍会因
     `packages/knowledge/fixtures/corpus.json`、`policies/` 下的 yml 等变成 CRLF，导致 boot 摘要校验
     与部分 policy 用例失败；本轮是本地把这些文件规范回 LF 后才跑绿的，未产生任何行尾提交。
  7. **合并风险**：`apps/web/src/transport.js` 在 `BAH/MonoRepo` 仍是 `UU`，本轮删除移动壳 `resume`
     会在合并时冲突；须按“坐席台保留 resume、移动壳不提供”的口径人工解。
- **口径**：本轮修复**只在 `mobile-ui-fix-01` 分支**，未合入 `integration/handoff-tenant`、
  未推送、未动 `main`。在 P1-5 / P1-6 关闭前，**不能说“移动端已整体可用”**。

## 96.45 2026-10-29 IM 网关 01 对抗式复审（不改代码）

审查对象：`78ad410`（IM 网关 01：渠道内核与会话映射）。审查在独立 worktree（`imgw-line`）内做，
临时探针文件跑完即删，仓库只多出本条记录。

### 96.45.1 方法

1. **主动构造攻击**（不是重跑单测）：会话键撞库、指令解析绕过矩阵、无会话适配器投票、段重复注册、URL 文本出站；
2. **负控注入**：把 `channel:im` 的 `use` 改成 `channel:web`、把能力位值就地写死、在 `plugins/im.ts` 加 `console.warn`；
3. **零改动证据**：对既有渠道与提示词/快照做 diff；
4. **回放证据**：快照套件（含 `web-channel`）全绿。

### 96.45.2 对抗结果（01 相关不变量）

| 不变量 / 纪律 | 攻击 | 结果 |
|---|---|---|
| 契约唯一（02 G13 的前置） | 全仓搜 `interface PlatformAdapter` | 仅 `packages/channels/src/im/platform.ts:96` 一处 |
| I-IM-15 不复制审批语义 | 搜 `im/` 源码的 `decide(` / `attachApproval(` 实现 | 0 处（只有测试在调用）；六码文案只在 `http-adapter.ts` 定义 |
| I-IM-05 标识不落日志/不进 ID | 搜 `im/` 的 `logJson` / `console.`；探针 P1 | 0 处日志调用；`('ab','c')` 与 `('a','bc')` 派生结果不同（NUL 分隔符有效）；ID 不含原文子串（单测） |
| I-IM-16 不破坏既有渠道 | `git diff --stat HEAD^ HEAD -- packages/host/src/boot/plugins/web packages/channels/src/web packages/channels/src/mobile packages/runtime/src/system-prompt snapshots apps/web` | **空**；`pnpm test:snapshot` 9 文件 / 39 例全绿（含 `web-channel` 的 record→replay 逐条全等） |
| I-IM-17 段只由 `channel:im` 注册 | 探针 P5：同 id 二次注册 | `prompt-section-duplicate`；dispose 后可再次注册（`T-CH-014` 用真插件生命周期验证）；默认六段 ids 逐字不变 |
| I9 薄壳纪律 | 行数统计 + 负控 `console.warn` | 64 行（≤80）、无分发符号；注入 `console.*` 后 `verify-observability` 红（已还原） |
| I-IM-02 密钥只在 env | 搜 `im/` 的 AppID/Secret/Token 字面量 | 0 处（01 不涉及平台密钥，02 才接线） |

负控实跑（均已还原）：

```text
✘ channel-capabilities · I4 channel:im 行的 use 必须是 'channel:im'（实际 channel:web）
✘ adapter.test.ts · T-CH-002 同一引用断言失败（能力位被就地写死成 10 字段字面量）
✘ observability · packages/host/src/boot/plugins/im.ts: 仍有 1 处 console.*（白名单只 2 个文件）
```

> 修正上一轮复审对能力位负控的预期：门禁 I3 只校验 `capabilities: {…}` 的**键集**，
> 拦不住"同值字面量复制"；真正拦它的是 T-CH-002 的**同一引用**断言。两者都要，别拿门禁替代测试。

### 96.45.3 新发现（登记，不属 01 修复范围）

| ID | 级别 | 发现 | 证据 | 处置 |
|---|---|---|---|---|
| F-01 | 中 | **无 `sessionId` 的适配器会接受任意票据**：`createImChannelAdapter()` 不传 sessionId 时归属校验整体跳过 | 探针 P4：`decide` 返回 `{"ok":true}`（票据属于 `s-victim`） | 继承自共用 `http-adapter`（web/mobile 同）；生产宿主必传（`web/channel.ts` 装配时传 `session.sessionId`），但**无门禁强制**。转为 02 开工前置：子进程侧必须绑定会话，建议 02 G8 增"IM 适配器必须绑定 `sessionId`"判据 |
| F-02 | 低 | 平台 id **前导空白被归一**：`' wechat'` 与 `'wechat'` 得同一会话；尾随空白不归一（在 `\0` 前属内部） | 探针 P2：`lead=SAME trail=distinct` | 平台 id 是代码常量（`'wechat'`/`'mock'`），不可由用户输入；如实登记不改 |
| F-03 | 低 | 单个 ASCII token 被当票据号：`2 no`（想拒绝、理由 "no"）不识别，落普通消息 | 探针 P3：`"2 no" -> undefined` | 取舍是"宁可不识别也不误拒"（§2.5 拒绝理由必填）；03 若要做英文理由，需先改票据号形态判据 |
| F-04 | 信息 | 全角数字不识别：`１` → 普通消息 | 探针 P3 | 不会误批（非指令即普通消息）；03 可加全角归一 |
| F-05 | 信息 | NBSP 可作分隔：`1\u00a0ticket:abc` 能解析（JS `\s` 含 NBSP） | 探针 P3 | 只对字面量指令生效，不扩大攻击面；不改 |
| F-06 | 信息 | 审批摘要原样带出 `amountText` 中的 URL 文本 | 探针 P6：文本含 `http://evil.example/approve` | 这是**数据不是生成链接**（签名在 03）；02 出站层禁止自动 linkify、禁止把消息当链接发 |

### 96.45.4 结论与证据

- 01 出口五条 + 相关不变量全部经**实跑对抗**；两条负控红过并还原；快照与既有渠道零改动。
- 01 判定：**复审通过**。唯一实质风险 F-01 不属 01（共用适配器语义），但成为 **02 开工前置**。
- 证据命令：`pnpm exec vitest run packages/channels packages/host`（87 文件 / 1016 例）、
  `pnpm gate`（50/50）、`pnpm test:snapshot`（9/39）、`pnpm exec tsx scripts/verify-observability.ts`（负控后红）。

---

## 96.46 IM 网关 02 · 通用网关与微信适配器（2026-10-30）

### 96.46.1 出口标准（施工单 02 §0）

| # | 标准 | 证据 |
|---|---|---|
| 1 | 通用路由可启动：`GET /healthz` 200；`/im/:platform/:accountKey` 由注册表分派；未知平台/账号 404 | `gateway-flow.test.ts` 的「HTTP 路由」7 例 |
| 2 | `PlatformAdapter` 契约唯一实现点；微信与 Mock 跑同一套契约测试 | `platform-contract.test.ts` 16 例（`describe.each` 双实现）；门禁 G13 |
| 3 | mock 端到端：入站 → 子进程 `/api/turn` → SSE 帧 → 出站回复 | `gateway-flow.test.ts` + `fake-child.ts` |
| 4 | 一平台用户一子进程；跨平台不撞会话；重启可回放 | `supervisor.test.ts` 14 例（复用/并发单飞/跨平台/崩溃重启/回收） |
| 5 | 验签常量时间、时间戳窗口、DTD 拒绝、报文上限、去重、限流、用户标识不落日志 | `channels/im/protocol/*.test.ts`（76 例）+ 门禁 G2/G3/G7 |
| 6 | 推送降级：客服消息不可用 → 拉取式，用户发 `0` 取回 | `deliverTurn` 7 例 + `handleInbound` 的 fetch-latest 例 |
| 7 | 真机 D0 有书面结论 | **未执行**（Q1 缺凭据）；`docs/wechat-setup.md` §D0.5 模板 + `docs/evidence/2026-11-im-gateway/` 已登记 |
| 8 | 生产 registry 只注册 `wechat`；Mock 只在测试 harness | 门禁 G11/G12 |
| 9 | `verify-im-gateway` 全绿且负控可红 | G1–G13 全绿；负控见 §96.46.4 |

### 96.46.2 实跑数字

- `pnpm test`：**309 文件 / 3542 例**全绿（02 新增 9 文件 / 162 例）。
- `pnpm typecheck`：0 error（host + client + scripts 三套）。
- `pnpm lint`：0 error。
- `pnpm gate`：**51/51**（新增 `verify-im-gateway`）。
- `channels/im/**` 覆盖率：行/语句/函数 **100%**，分支 ≥ 89.74%（阈值 80%）。
- `pnpm test:coverage` 全仓仍有既有欠账（`host/web/{auth,handlers,csrf,config,router,handoff*}` 低于 100%），
  与 01 单登记一致；本单未引入新的低于 100% 文件。

### 96.46.3 与施工单的偏差（同批登记 `docs/im-gateway.md` §5）

| # | 偏差 | 理由 |
|---|---|---|
| 1 | `createRegistry(adapters, accounts?)` 增加第二参数 | 契约无 `accountKey`；账号清单由装配注入 |
| 2 | 02 只接线 `0`（拉取）；审批指令按普通文本转发 | 审批语义属 03，提前消费会形成第二套真相 |
| 3 | D0 未执行 | Q1 凭据未提供；Mock + 假微信 API 已自动化验证 |
| 4 | `apps/im-gateway` 不进覆盖率强制名单 | `COVERAGE_ALLOWLIST` 只认 `packages/*`；判决面在 `channels/im` |
| 5 | 新增日志码 `im-gateway-start` | §2.15 表缺"网关启动"事件 |
| 6 | 订阅 SSE 后最多等 500ms | 先 turn 后订阅会丢第一条回复 |
| 7 | 重启上限按 `firstStartAt` 的 10 分钟窗口 | §2.11 原文，不随重启重置 |
| 8 | 就绪探针文件改名 `ready.ts`（原本 `handshake.ts`） | `'./handshake.ts'` 含子串 `dsh`，被 `verify-no-upstream-imports` 正则误判；零语义规避 |

### 96.46.4 负控（门禁可红）

| # | 注入 | 结果 |
|---|---|---|
| G1 | `config.ts` 写入形如真实 AppID 的字面量 | `verify-im-gateway` 红（G1），已还原 |
| G5 | overlay 的 `host` 改成 `0.0.0.0` | 红（G5），已还原 |
| G7 | `turn.ts` 的 `log.warn` 带 `userId` | 红（G7），已还原 |
| G10 | `server.ts` import `parseWechatXml` | 红（G10），已还原 |
| G11 | `main.ts` 注册 mock | 红（G11），已还原 |
| G13 | apps 里复制 `interface PlatformAdapter` | 红（G13），已还原 |

### 96.46.5 结论

02 出口九条中八条有实跑证据；第 7 条（真机 D0）因 Q1 凭据缺失**如实登记为未执行**，
不以 Mock 结果冒充真机。03 开工前置：拿到凭据后补 D0，并把 `BAH_IM_PUSH_MODE` 的默认值按实测结论定稿。

---

## 96.47 IM 网关 02 · 对抗式复审记录（2026-10-30）

> 对应提交：实现 `648ef73`、审查修复 `9ceb2b9`、本记录单独提交。
> 方法：临时探针（跑完删除）+ 门禁负控（跑完还原）+ 对**修复项**补回归测试。

### 96.47.1 对抗探针（9 条，全绿）

| # | 攻击 | 结果 |
|---|---|---|
| A1 | 重放 601 秒前的签名 | `im-sig-stale`（401），不解析 XML |
| A2 | 改 nonce 但保留原签名 | `im-sig-mismatch` |
| A3 | 同名 `signature` 参数（正确在前、伪造在后） | 401（`URLSearchParams` 取最后一个，伪造覆盖正确） |
| A4 | 20 KiB 报文 | 413；响应体不含原文 marker |
| A5 | `<!DOCTYPE>` + 实体膨胀 | 400；`handleMessage` 未调用 |
| A6 | `/im/feishu/default`（未注册平台） | 404；不 spawn、不跑 turn |
| A7 | GET 无 `echostr` | 400（不是 200 空体） |
| A8 | 日志字段带 `userId/openid` | 整条丢弃（只剩 `reason`） |
| A9 | 把 mock 适配器挂到同一 HTTP 路由 | 正常分派（路由不认微信；契约可替换） |

> 探针自身先修过两处错误（`nowMs` 未注入导致误报 stale；mock 重复注册导致 404）。
> 结论：**对抗结论必须建立在正确的探针上**，探针红先查探针。

### 96.47.2 门禁负控（6 条，全红并还原）

| # | 注入 | 首轮结果 | 处置 |
|---|---|---|---|
| G1 | `config.ts` 写 `wx0123456789abcdef` | 红 | 还原 |
| G5 | overlay `host: 0.0.0.0` | 红 | 还原 |
| G7 | `log.warn` 参数加 `userId`（跨行写） | **未红** → 修门禁后红 | 还原；门禁改括号配对扫描 |
| G10 | `server.ts` import `protocol/xml.ts` | 红 | 还原 |
| G11 | `main.ts` import `createMockAdapter` | 红（两处） | 还原 |
| G13 | apps 里复制 `interface PlatformAdapter` | 红 | 删除 |

**G7 首轮未红是本次复审最重要的发现**：按行扫描会把跨行日志参数漏掉，
等于"日志泄露 userId"这条判据在最常见的写法下失效。已改为 `logCalls()`（括号配对跨行）。

### 96.47.3 修复项（5 个代码缺陷 + 1 个门禁缺陷）

| ID | 级别 | 缺陷 | 证据（修复前红） | 修复 |
|---|---|---|---|---|
| R-01 | 高 | `passiveReply=false` 平台仍调 `reply.passive`（能力位与行为不一致） | 回归例 `passive-unavailable` 抛出 | `deliverTurn` 的 ack 按能力位给空体 |
| R-02 | 高 | `server.ts` 的 `void outcome.done` 未 catch → unhandledRejection 可致进程退出 | 回归例 `unhandled=1` | server 层 `catch` + `im-turn-failed` |
| R-03 | 中 | `prefixChunks` 固定预留 10 字节；1000 片时前缀 12 字节 → 2049 > 2048 | 回归例 2049 > 2048 | 按实际片数迭代预算 |
| R-04 | 中 | `maxChildren` 未计 `starting` → 并发 ensure 突破上限（TOCTOU） | 回归例 2 个 fulfilled | `registry.size() + starting.size` |
| R-05 | 中 | 入站 CDATA 未还原 `]]>` 拆分（与 `cdata()` 不对称，用户发 `]]>` 会看到乱码） | 回归例解析出转义串 | `decodeValue` 反向 split/join |
| R-06 | 高 | G7 门禁按行扫描漏跨行日志调用 | 负控未红（见 §96.47.2） | `logCalls()` 括号配对 |

修复后：`pnpm test` **309 文件 / 3547 例**、`pnpm typecheck` 0 error、`pnpm gate` **51/51**、
`channels/im/**` 覆盖率行/语句/函数 100%。

### 96.47.4 登记但不修

| ID | 级别 | 事项 | 判断 |
|---|---|---|---|
| R-07 | 信息 | 01 的 F-01（无 `sessionId` 适配器接受任意票据）仍无门禁 | 生产路径 `channel.ts:92-95` **必传** `sessionId: String(session.sessionId)`；02 的子进程也经 `createHttpChannel` 装配 ⇒ 实际风险闭合，但缺机器判据 |
| R-08 | 信息 | 子进程 env 清洗（`SCRUBBED_ENV`）无直接单测 | 注入 launcher 只能验证显式 env（只有 `BAH_WEB_TOKEN`）；默认 launcher 的 `scrubbedEnv()` 靠代码审阅。补测需导出该函数，属可做未做 |
| R-09 | 信息 | 去重窗口进程内、重启即丢 | §2.10 已登记；微信只重试 3 次，不承诺跨重启幂等 |

### 96.47.5 结论

- 02 判定：**复审通过**。5 个代码缺陷均先有红灯回归、再有修复；1 个门禁缺陷（G7 跨行盲区）已修。
- 遗留只在"真机 D0"与"无凭据的客服消息权限"上，且已如实登记，不以 Mock 冒充。
- 03 开工前置：① Q1 凭据到位后补 D0 并定稿 `BAH_IM_PUSH_MODE`；② 03 落地时把 G6/G9 从"未落地断言"转强制。

---

## 96.48 02 真机部署（云服务器，2026-10-30）

| 项 | 结果 |
|---|---|
| 代码 | `/opt/bah/IMGW`（bundle 传输，imgw-line @`6589f05`） |
| 依赖/构建 | `pnpm install --frozen-lockfile` + `pnpm build` 通过 |
| 服务 | `bah-im.service`（`/etc/bah/im.env` 600，`127.0.0.1:8081`） |
| 公网入口 | nginx 80 → 8081；`http://124.71.73.29/im/wechat/default` |
| 握手 | 模拟签名 GET `echostr` → 200 原样回显 |
| 消息 | 模拟 POST「查余额」→ 200 + 余额被动回复（冷启动约 12 秒） |
| 重启 | 网关重启后同用户仍 200 + 回复；归档后不再出现 `session-exists` |

真机部署暴露并修复两项（施工单 02 §2.11 的 spawn 形状未写清）：

- **R-10**：spawn 缺 `--serve` —— CLI 在 boot 期要求 `--prompt` 并退出；`argsFor` 已补，测试断言 `--serve`。
- **R-11**：同一 sessionKey 重启时宿主 `core:persistence` 的 `create` 是排他写
  （`jsonl: 会话已存在，拒绝覆写`，实测 11 条 error）；网关在 spawn 前归档旧会话目录
  （`prepareJsonlRoot`，旧目录改名 `-prev-<ts>` 保留审计）。
  **边界（如实登记）**：跨进程的对话上下文延续需要宿主持久化插件支持
  `open(dir,{mode:'append'})`；本单未改宿主，重启后从空会话开始。

> 服务器侧仍用占位微信三项（`pending-*`），`/healthz` 与握手可用；真机 D0 待 Q1 凭据。

## 96.49 03 审批交互与坐席接管（mock 面，2026-10-30）

| 项 | 结果 |
|---|---|
| 出口 1：文本指令闭环 | `1` 批准 / `2` 拒绝（理由必填）/ `3` 详情 / `4` 强验证；多票据强制带票号 |
| 出口 2：H5 审批页 | `/a/:token` 签名 + 一次性 + TTL；CSP `default-src 'none'`；批准 / 拒绝 / 强验证可用 |
| 出口 3：过期语义 | `approval-closed(unavailable)` → 推送「已过期」，绝不写成「已批准」 |
| 出口 4：转人工 | `转人工` → 子进程 `POST /api/handoff`；进入 / 认领 / 交回三态推送 |
| 出口 5：运营桥 | `/seat/*` 未配 token 一律 404；错 token 401；对 token 才转发白名单路径；列表不含平台用户标识 |
| 出口 6：审计与日志 | 审批 / 运营面只记 sessionKey / ticketId / code / 理由长度；G15 钉死 |

实现要点：

- `channels/im/protocol/link-token.ts`：`base64url(JSON) + '.' + HMAC-SHA256`，`timingSafeEqual`，`now >= e` 即 `expired`；
- `apps/im-gateway/src/approval/{pending,commands,texts,submit,page}.ts`：待审批表 / 票据选择 / 文案 / 六码翻译 / H5；
- `apps/im-gateway/src/session/hub.ts`：**每条会话一条常驻 SSE**（快照重建 + 增量推送），与 02 的 per-turn 订阅并行；
  `beginTurn/endTurn` 闸门避免同一条助手消息被推两次；断线后下一次 attach 重新订阅；
- `apps/im-gateway/src/handoff/{bridge,operator}.ts`：接管三态归约 + 公网运营桥（子进程独立 operator token + CSRF）；
- `assets/approve.{html,css,js}`：零框架、零远程、无内联脚本。

实跑数字（2026-10-30）：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 error |
| `pnpm test` | **315 文件 / 3607 例**全绿（03 新增 6 文件 / 57 例） |
| `pnpm gate` | **51/51**（`verify-im-gateway` G1–G15） |
| `pnpm test:snapshot` | 9 文件 / 39 例 |
| 覆盖率 | `channels/im/**` 逐文件 100% 行/语句/函数；`link-token.ts` 分支 93.33% |

门禁负控（4 条，实跑判红并还原）：

- G6：去掉 `server.ts` 的 `deps.seatEnabled !== true` → 红；
- G9：`approve.html` 加内联 `<script>` → 红；
- G14：`link-token.ts` 用 `===` 比签名 → 红；
- G15：`approval/page.ts` 日志加 `reason:` → 红。

偏差与边界（同 `docs/im-gateway.md` §5）：

1. 宿主 `WebDeps` 拆出 `seatApiEnabled`：原 `seatEnabled` 只对 `channel:web` 为真，IM 子进程没有 `/operator` 页面但运营桥必须转发坐席 API；
2. 03 新增 `session/hub.ts` / `handoff/bridge.ts` / `approval/texts.ts`（施工单文件清单未列），用于常驻 SSE 与跨轮状态；
3. 03 §6 的两条门禁编号顺延为 **G14 / G15**（02 已占用 G10–G13）；
4. 新增 `BAH_OPERATOR_NAME`（缺省 `坐席`），随网关注入子进程；
5. H5 一次性在"解析成功且通过红级前置"后才 claim，避免空理由 / 红级拦截烧掉链接；
6. 01 的解析口径下 `2` 只给票号不给理由**不识别为指令**；H5 的空理由仍回 400 `reason-required`。

已知边界：

- 待审批 / 接管状态在网关内存；子进程被回收即清空，网关重启不补发历史；
- 常驻 SSE 断开后不自动重连，下一次入站重新 attach 并按快照重建；
- H5 需要公网 HTTPS（本地允许 `http://127.0.0.1`）；无 `BAH_IM_PUBLIC_BASE_URL` 时省略 H5 行，文本指令仍可用；
- D0 真机（审批 / H5 / 运营桥）仍未执行，阻塞同 Q1。

结论：03 的 mock 面已闭环，门禁与测试全绿；真机 D0 待 Q1 凭据。

## 96.50 D0 真机探针（2026-10-30）

Q1 凭据到位（测试号 AppID / AppSecret / Token），公网入口沿用 `http://124.71.73.29/im/wechat/default`（nginx 80 → 8081）。

| 项 | 结论 |
|---|---|
| 部署 | `/opt/bah/IMGW` 从 `6589f05` 快进到 `b8d8543`；`pnpm install --frozen-lockfile` + `pnpm build` 通过 |
| 凭据 | 写入 `/etc/bah/im.env`（600）；三项长度 18 / 32 / 25；另生成 `BAH_IM_LINK_SECRET`（48）与 `BAH_IM_OPERATOR_TOKEN`（32） |
| 握手 | 服务器内 + 公网 GET `echostr` 均 200 原样回显 |
| 被动回复 | 真机发「查余额」收到余额；公网 POST 也 200（模型回复） |
| 03 路由 | `/a/abc.def`→403、`/seat/sessions` 无 token→401、`/assets/approve.css`→200 |
| 客服消息 | 待测（未触发 >4s 回合） |
| H5 真机 | 阻塞：公网 http IP，H5 只允许 https 或 127.0.0.1 |

真机暴露的三个问题（已修，均为 01/02 的口径缺口）：

- **D0-1 children-full**：`BAH_IM_MAX_CHILDREN=2` 被两条探针会话占满，真机第二条消息起回「当前咨询人数较多」。
  部署值调到 6（配置项，不改代码）。
- **D0-2 choice 不显示**：`prompt_ask` 的选择题帧被 `render.ts` 当表外帧丢弃，用户只看到「请选择一下」，
  看不到候选（王建国 / 张伟）。已把 `choice` 投影为「问题 + ·候选 + 回复提示」，不编号（回填走 label）。
- **D0-3 裸 `1` 被拦截**：模型问「要转给谁」后用户回 `1`，网关按审批指令回「当前没有待审批」。
  已改为：**无待审批时不拦截**，交还对话题；有票时审批优先（T-IM-004 仍走审批）。

复跑：`pnpm typecheck` 0 error；`pnpm test` **315 文件 / 3607 例**；`pnpm gate` 51/51。

> 演示夹具的转账话术要带收款人姓名（候选：王建国 / 张伟）；"转账 100 元给张三"里的张三与当前用户同名，
> 抽取为空，模型会追问收款人。真机复测用「给王建国转 100 元」。
