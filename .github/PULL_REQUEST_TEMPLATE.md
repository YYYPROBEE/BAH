## 这个 PR 做了什么

<!-- 一句话说明行为差异，不要写"改了哪些文件" -->

## 为什么

<!-- 动机、约束、取舍。与 issue 关联时写 Closes #123 -->

## 怎么验证的

<!-- 贴关键命令与输出，尤其是 pnpm check / pnpm gate 的汇总行 -->

```text
$ pnpm gate
$ pnpm check
```

## 影响面

- [ ] 行为变化（已带用例）
- [ ] 契约变化（`docs/contracts/*` 已同步：事件表 / 工具契约 / 场景 DSL）
- [ ] 装配或 profile 变化（已重录快照并跑 `pnpm test:snapshot`）
- [ ] 门禁或数字口径变化（`facts.md`、`docs/facts-sources.md` 已同步）
- [ ] 工具出参变化（`result-schemas.ts` 与 `docs/tool-catalog.md` 已同步）
- [ ] 仅文档 / 注释

## 已知限制

<!-- 没做完的部分、刻意不做的部分、留待后续的风险；没有就写"无" -->

## 许可

- [ ] 我确认本次贡献按 Apache-2.0（inbound = outbound）授权，且不包含我无权提交的第三方代码
