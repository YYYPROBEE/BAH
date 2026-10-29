/**
 * D 族 · 编排（plan，10）。
 *
 * 计划由数据构造、不走模型（W10/W11 的既有能力）。断言只认 `plan/*` 事件与工具结果，
 * 不认引擎内部状态——状态必须由事件还原。
 */

import { scenario } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'
import type { Plan } from '@bah/runtime'

function planOf(id: string, title: string, nodes: Plan['nodes']): Plan {
  return { planId: `eval-${id}`, meta: { title }, nodes }
}

const PAYEE = { name: '王建国' }

export const D_SCENARIOS: readonly EvalScenario[] = [
  scenario({
    id: 'D-01',
    family: 'D',
    title: '串行三节点：余额 → 产品 → 对比，全部成功',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/created', where: { dryRun: false } },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 3 } },
      { kind: 'tool-result', tool: 'account_balance', path: 'balanceCents', equals: 1_234_567 },
      { kind: 'tool-sequence', tools: ['account_balance', 'wealth_list', 'wealth_compare'], mode: 'prefix' },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-01', '串行读三节点', [
        { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
        { id: 'products', tool: 'wealth_list', args: {}, deps: ['balance'] },
        { id: 'compare', tool: 'wealth_compare', args: { ids: ['w-1', 'w-2'] }, deps: ['products'] },
      ]),
    },
  }),
  scenario({
    id: 'D-02',
    family: 'D',
    title: '菱形依赖：一个根扇出两个节点再汇合，四节点全部成功',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 4 } },
      { kind: 'event', type: 'plan/node-result', where: { nodeId: 'join', status: 'succeeded' } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-02', '菱形依赖', [
        { id: 'root', tool: 'account_balance', args: {}, deps: [] },
        { id: 'left', tool: 'wealth_list', args: {}, deps: ['root'] },
        { id: 'right', tool: 'txn_query', args: { range: { from: '2023-09-01T00:00:00.000Z', to: '2023-12-31T23:59:59.999Z' } }, deps: ['root'] },
        { id: 'join', tool: 'analysis_calc', args: { code: '1+1' }, deps: ['left', 'right'] },
      ]),
    },
  }),
  scenario({
    id: 'D-03',
    family: 'D',
    title: 'optional 节点：上游失败 → 下游 skipped（不是 blocked）',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/node-result', where: { nodeId: 'soft', status: 'skipped' } },
      { kind: 'event', type: 'plan/completed', where: { status: 'failed', skipped: 1 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-03', 'optional 跳过', [
        { id: 'boom', tool: 'eval_fail', args: {}, deps: [] },
        { id: 'soft', tool: 'eval_seed', args: {}, deps: ['boom'], optional: true },
      ]),
    },
  }),
  scenario({
    id: 'D-04',
    family: 'D',
    title: '非 optional 节点：上游失败 → blocked',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/node-blocked', where: { nodeId: 'hard', reason: 'upstream-failed' } },
      { kind: 'event', type: 'plan/completed', where: { status: 'failed', blocked: 1 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-04', 'blocked 传播', [
        { id: 'boom', tool: 'eval_fail', args: {}, deps: [] },
        { id: 'hard', tool: 'eval_seed', args: {}, deps: ['boom'] },
      ]),
    },
  }),
  scenario({
    id: 'D-05',
    family: 'D',
    title: 'dry-run：计划成功但不执行任何工具（零 tool/call）',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/created', where: { dryRun: true } },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded' } },
      { kind: 'no-event', type: 'tool/call' },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      dryRun: true,
      plan: planOf('D-05', 'dry-run', [
        { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
        { id: 'products', tool: 'wealth_list', args: {}, deps: ['balance'] },
      ]),
    },
  }),
  scenario({
    id: 'D-06',
    family: 'D',
    title: '断点续跑：首次失败 → resume 重跑失败节点 → 全部成功',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/resumed' },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 2 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      resume: true,
      resumeFrom: ['flaky'],
      plan: planOf('D-06', 'resume', [
        { id: 'flaky', tool: 'eval_flaky', args: {}, deps: [] },
        { id: 'calc', tool: 'analysis_calc', args: { code: '1+1' }, deps: ['flaky'] },
      ]),
    },
  }),
  scenario({
    id: 'D-07',
    family: 'D',
    title: '动态 args：下游表达式来自上游输出（${node.path}）',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 2 } },
      { kind: 'tool-result', tool: 'analysis_calc', path: 'value', equals: 2 },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-07', '动态参数', [
        { id: 'seed', tool: 'eval_seed', args: {}, deps: [] },
        { id: 'calc', tool: 'analysis_calc', args: { code: '${node.seed.code}' }, deps: ['seed'] },
      ]),
    },
  }),
  scenario({
    id: 'D-08',
    family: 'D',
    title: '上游不可用 → incident（node-result 带 upstream-unavailable）',
    turns: [],
    profile: 'plan',
    expect: [
      {
        kind: 'event',
        type: 'plan/node-result',
        where: { nodeId: 'down', status: 'failed', code: 'upstream-unavailable' },
      },
      { kind: 'event', type: 'plan/completed', where: { status: 'failed' } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-08', 'incident', [
        { id: 'down', tool: 'eval_upstream_down', args: {}, deps: [] },
      ]),
    },
  }),
  scenario({
    id: 'D-09',
    family: 'D',
    title: '两个根节点都失败 → completed 统计 failed=2',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/completed', where: { status: 'failed', failed: 2 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-09', '双失败', [
        { id: 'a', tool: 'eval_fail', args: {}, deps: [] },
        { id: 'b', tool: 'eval_fail', args: {}, deps: [] },
      ]),
    },
  }),
  scenario({
    id: 'D-10',
    family: 'D',
    title: '编排内转账：试算 → 扣款，每个写节点各走一次审批',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'transfer/created' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 2 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-10', '编排转账', [
        { id: 'preview', tool: 'transfer_preview', args: { amount: 800, payee: PAYEE }, deps: [] },
        { id: 'pay', tool: 'transfer_create', args: { amount: 800, payee: PAYEE }, deps: ['preview'] },
      ]),
    },
  }),

  /* ── 04 单：跨场景编排（D-11…D-15）────────────────────────────────────── */

  scenario({
    id: 'D-11',
    family: 'D',
    title: '生日案例：6 节点 DAG，三笔转账各自执行（每笔独立审批）',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 6 } },
      // 计划批准 ≠ 节点批准：三个 create 节点各自过审批（至少一条 asked 证据）
      { kind: 'event', type: 'approval/asked', where: { name: 'transfer_create' } },
      // 最后一笔 = 蛋糕店 30 元：证明第三笔是按自己的 args 执行的，不是复用第一笔
      { kind: 'tool-result', tool: 'transfer_create', path: 'amountCents', equals: 3_000 },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-11', '生日案例：锁定 + 鲜花 + 蛋糕', [
        { id: 'a1', tool: 'transfer_preview', args: { amount: 100, payee: { name: '锁定账户(9012)' } }, deps: [] },
        { id: 'a2', tool: 'transfer_create', args: { amount: 100, payee: { name: '锁定账户(9012)', memo: '生日预算锁定' } }, deps: ['a1'] },
        { id: 'b1', tool: 'transfer_preview', args: { amount: 50, payee: { name: '馨香花艺' } }, deps: ['a2'] },
        { id: 'c1', tool: 'transfer_preview', args: { amount: 30, payee: { name: '甜心蛋糕坊' } }, deps: ['a2'] },
        { id: 'b2', tool: 'transfer_create', args: { amount: 50, payee: { name: '馨香花艺', memo: '生日鲜花预订款' } }, deps: ['b1'] },
        { id: 'c2', tool: 'transfer_create', args: { amount: 30, payee: { name: '甜心蛋糕坊', memo: '生日蛋糕预订款' } }, deps: ['c1'] },
      ]),
    },
  }),
  scenario({
    id: 'D-12',
    family: 'D',
    title: '拓扑序：节点 ordinal 与边约束一致（b/c 两支在 a2 之后）',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/node-started', where: { nodeId: 'a2', ordinal: 2 } },
      { kind: 'event', type: 'plan/node-started', where: { nodeId: 'b1', ordinal: 3 } },
      { kind: 'event', type: 'plan/node-started', where: { nodeId: 'c1', ordinal: 4 } },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 4 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-12', '菱形编排（读类，无资金）', [
        { id: 'a1', tool: 'account_balance', args: {}, deps: [] },
        { id: 'a2', tool: 'wealth_list', args: {}, deps: ['a1'] },
        { id: 'b1', tool: 'wealth_compare', args: { ids: ['w-1', 'w-2'] }, deps: ['a2'] },
        { id: 'c1', tool: 'txn_query', args: { range: { from: '2023-09-01T00:00:00.000Z', to: '2023-12-31T23:59:59.999Z' } }, deps: ['a2'] },
      ]),
    },
  }),
  scenario({
    id: 'D-13',
    family: 'D',
    title: '上游失败 BFS 传播：a2 失败 ⇒ 两层下游全部 blocked',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/node-blocked', where: { nodeId: 'b1', reason: 'upstream-failed' } },
      { kind: 'event', type: 'plan/node-blocked', where: { nodeId: 'c1', reason: 'upstream-failed' } },
      { kind: 'event', type: 'plan/node-blocked', where: { nodeId: 'b2', reason: 'upstream-blocked' } },
      { kind: 'event', type: 'plan/completed', where: { status: 'failed', blocked: 3 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-13', '失败传播两层', [
        { id: 'a1', tool: 'account_balance', args: {}, deps: [] },
        { id: 'a2', tool: 'eval_fail', args: {}, deps: ['a1'] },
        { id: 'b1', tool: 'wealth_list', args: {}, deps: ['a2'] },
        { id: 'c1', tool: 'account_balance', args: {}, deps: ['a2'] },
        { id: 'b2', tool: 'wealth_list', args: {}, deps: ['b1'] },
      ]),
    },
  }),
  scenario({
    id: 'D-14',
    family: 'D',
    title: 'optional 失败只 skipped 不阻断：独立支照常执行',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/node-result', where: { nodeId: 'b1', status: 'failed' } },
      { kind: 'event', type: 'plan/node-result', where: { nodeId: 'b2', status: 'skipped' } },
      { kind: 'event', type: 'plan/node-result', where: { nodeId: 'c2', status: 'succeeded' } },
      { kind: 'event', type: 'plan/completed', where: { status: 'failed', failed: 1, skipped: 1 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      plan: planOf('D-14', 'optional 跳过', [
        { id: 'a1', tool: 'account_balance', args: {}, deps: [] },
        { id: 'b1', tool: 'eval_fail', args: {}, deps: ['a1'] },
        { id: 'b2', tool: 'wealth_list', args: {}, deps: ['b1'], optional: true },
        { id: 'c1', tool: 'wealth_list', args: {}, deps: ['a1'] },
        { id: 'c2', tool: 'analysis_calc', args: { code: '1+1' }, deps: ['c1'] },
      ]),
    },
  }),
  scenario({
    id: 'D-15',
    family: 'D',
    title: '续跑不重跑 succeeded：plan/resumed.skipped 计到已成功节点',
    turns: [],
    profile: 'plan',
    expect: [
      { kind: 'event', type: 'plan/resumed', where: { skipped: 1 } },
      { kind: 'event', type: 'plan/completed', where: { status: 'succeeded', succeeded: 2 } },
    ],
    metric: 'task-success',
    action: {
      kind: 'plan',
      resume: true,
      resumeFrom: ['flaky'],
      plan: planOf('D-15', '续跑不重跑', [
        { id: 'seed', tool: 'eval_seed', args: {}, deps: [] },
        { id: 'flaky', tool: 'eval_flaky', args: {}, deps: ['seed'] },
      ]),
    },
  }),
]
