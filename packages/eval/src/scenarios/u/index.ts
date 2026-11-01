/**
 * U 族 · 意图语料（17）。
 *
 * 来源：01 卷 §3.2 的 30 条实战语料，剔除 D/E/F 三类当前无承载的句子后固化 17 条。
 * 目标不是"证明系统什么都懂"，而是**把意图层当前的判定钉成回归网**：
 * 跑批红了就说明词表或规则被改了，改得对不对由人看标题里的偏差标注。
 *
 * ## 执行顺序有意义
 *
 * 数组顺序 ≠ ID 顺序。C 类（U-15/U-16/U-17）与 U-07 先跑：它们要在**会话槽位为空**的
 * 干净基线上取证（`intent:plane` 的会话槽位在同一个 boot 组内跨场景存活）。
 * 之后 U-01 建立"妈 / 500"的会话锚点，其余场景按 ID 顺序执行。
 *
 * ## 偏差标注口径
 *
 * - 🟢 = 与 01 卷预期一致；
 * - 🟡 = 与 01 卷预期有偏差但**保守**（追问而非 proceed），偏差写进 title 让它可见；
 * - 🔴 = 缺槽位却 proceed 这类资金风险级缺陷，不进本族（本族无此类）。
 */

import { textStep, toolCallStep } from '@bah/llm/mock'

import { scenario } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'

/** 每条都带：意图判定不产生任何资金动作。 */
const NO_TRANSFER = { kind: 'no-event', type: 'transfer/created' } as const

export const U_SCENARIOS: readonly EvalScenario[] = [
  /* ── C 类先跑：无会话槽位基线 ─────────────────────────────────────────── */
  scenario({
    id: 'U-15',
    family: 'U',
    title: '🟡 偏差：期望 vague，实测 explicit/ask——「把上周借老王的钱还了」无历史指代词，保守追问',
    turns: ['把上周借老王的钱还了'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.1', equals: 'amountCents' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '把上周借老王的钱还了', scene: 'transfer' }),
        textStep('缺收款人与金额，先追问，不发起任何资金动作。'),
      ],
    },
  }),
  scenario({
    id: 'U-16',
    family: 'U',
    title: '🟡 偏差：期望 vague，实测 explicit/ask——「还老王钱」缺收款人与金额，保守追问',
    turns: ['还老王钱'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.1', equals: 'amountCents' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '还老王钱', scene: 'transfer' }),
        textStep('缺收款人与金额，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-17',
    family: 'U',
    title: '🟢 指代复现：「刚才那个转账取消掉」⇒ vague + requiresPreview（复现必经预演）',
    turns: ['刚才那个转账取消掉'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'vague' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'requiresPreview', equals: true },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '刚才那个转账取消掉', scene: 'transfer' }),
        textStep('这是指代历史转账，必须先复现并确认。'),
      ],
    },
  }),
  scenario({
    id: 'U-07',
    family: 'U',
    title: '🟡 偏差：「转五百，不，八百」中文数字未归一（词表只认阿拉伯数字），保守追问',
    turns: ['转五百，不，八百'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.1', equals: 'amountCents' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '转五百，不，八百', scene: 'transfer' }),
        textStep('中文数字未归一，先追问收款人与金额。'),
      ],
    },
  }),

  /* ── A 类：直白可执行（U-01 起建立会话锚点） ───────────────────────────── */
  scenario({
    id: 'U-01',
    family: 'U',
    title: '🟢 直白：「给妈转 500」⇒ explicit/proceed，金额归一为 50000 分',
    turns: ['给妈转 500'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'proceed' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: '妈' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.1.value', equals: 50_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '给妈转 500', scene: 'transfer' }),
        textStep('已识别为给「妈」转 500 元；不产生资金动作。'),
      ],
    },
  }),
  scenario({
    id: 'U-02',
    family: 'U',
    title: '🟡 偏差：语序「转 500 给妈」——收款人抽取只认「给X转/转给X」，缺 payee 追问',
    turns: ['转 500 给妈'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 50_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '转 500 给妈', scene: 'transfer' }),
        textStep('收款人未识别，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-03',
    family: 'U',
    title: '🟡 偏差：「给妈转五百块钱生活费」中文数字未归一 → 缺 amountCents 追问',
    turns: ['给妈转五百块钱生活费'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'amountCents' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: '妈' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '给妈转五百块钱生活费', scene: 'transfer' }),
        textStep('金额未归一，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-04',
    family: 'U',
    title: '手机号收款人可识别：11 位号码不被当金额，金额 2000 归一为 200000 分',
    turns: ['给 13800005678 转 2000'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'proceed' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.name', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: '13800005678' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.1.name', equals: 'amountCents' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.1.value', equals: 200_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '给 13800005678 转 2000', scene: 'transfer' }),
        textStep('手机号收款人与金额都已抽出；执行时按新收款人升级审批。'),
      ],
    },
  }),
  scenario({
    id: 'U-05',
    family: 'U',
    title: '🟡 偏差：「1w」按 1 元归一（100 分），收款人未识别 → 追问（偏差可，不掩盖）',
    turns: ['转 1w 给自己另一张卡'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 100 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '转 1w 给自己另一张卡', scene: 'transfer' }),
        textStep('「1w」被按 1 元归一，收款人未识别，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-06',
    family: 'U',
    title: '🟡 偏差：双账户表述「工资卡…理财卡」只抽到金额 2000，收款人缺失 → 追问',
    turns: ['帮我把工资卡里的闲钱转 2000 到理财卡'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 200_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', {
          utterance: '帮我把工资卡里的闲钱转 2000 到理财卡',
          scene: 'transfer',
        }),
        textStep('只抽到金额，收款账户未识别，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-08',
    family: 'U',
    title: '🟡 偏差：跨场景到账单——缺 timeRange 追问；顺带暴露「给…转」误配把查询句抽成收款人',
    turns: ['给我看看我这个月转出去多少'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'timeRange' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', {
          utterance: '给我看看我这个月转出去多少',
          scene: 'bills',
        }),
        textStep('缺时间范围，先追问。'),
      ],
    },
  }),

  /* ── B 类：缺槽位该追问 ─────────────────────────────────────────────────── */
  scenario({
    id: 'U-09',
    family: 'U',
    title: '🟢 「帮我给房东转房租」⇒ explicit/ask，缺金额',
    turns: ['帮我给房东转房租'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'amountCents' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: '房东' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '帮我给房东转房租', scene: 'transfer' }),
        textStep('缺金额，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-10',
    family: 'U',
    title: '🟢 「转 800」⇒ explicit/ask，缺收款人；金额可归一',
    turns: ['转 800'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 80_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '转 800', scene: 'transfer' }),
        textStep('缺收款人，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-11',
    family: 'U',
    title: '🟢 两轮省略：「明天给房东转 3500」→「把明天的转账改成后天」⇒ elliptical/proceed（继承会话槽位）',
    turns: ['明天给房东转 3500', '把明天的转账改成后天'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'elliptical' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'proceed' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        // 第 1 轮：建立"房东 / 3500"的会话槽位
        toolCallStep('c1', 'intent_resolve', { utterance: '明天给房东转 3500', scene: 'transfer' }),
        textStep('已识别为给房东转 3500 元；不产生资金动作。'),
        // 第 2 轮：省略表达，只给 when 修正（断言只匹配最后一次 tool/result）
        toolCallStep('c2', 'intent_resolve', { utterance: '把明天的转账改成后天', scene: 'transfer' }),
        textStep('按上一轮槽位继承，仅修改时间。'),
      ],
    },
  }),
  scenario({
    id: 'U-12',
    family: 'U',
    title: '🟢 「给我妈转点钱」⇒ explicit/ask，缺金额（「点钱」不猜数）',
    turns: ['给我妈转点钱'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'amountCents' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: '我妈' },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '给我妈转点钱', scene: 'transfer' }),
        textStep('缺金额，先追问。'),
      ],
    },
  }),
  scenario({
    id: 'U-13',
    family: 'U',
    title: '🟢 实体歧义：「给张伟转 300」⇒ ambiguous/ask（demoMemory 两条张伟 ⇒ conflicts）',
    turns: ['给张伟转 300'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'ambiguous' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'conflicts.0.name', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 30_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '给张伟转 300', scene: 'transfer' }),
        textStep('两个张伟，先出选择题，不猜。'),
      ],
    },
  }),
  scenario({
    id: 'U-14',
    family: 'U',
    title: '🟡 偏差：「转 300 块给我对象」——「对象」不在亲属称谓词表，收款人缺失 → 追问',
    turns: ['转 300 块给我对象'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'explicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'missing.0', equals: 'payee' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'filled.0.value', equals: 30_000 },
      NO_TRANSFER,
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c1', 'intent_resolve', { utterance: '转 300 块给我对象', scene: 'transfer' }),
        textStep('收款人未识别，先追问。'),
      ],
    },
  }),
]
