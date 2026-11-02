/**
 * K 族 · 知识与拒答（10）。
 *
 * 走真实 HTTP 端口 + 本地验签门（W06）：命中必须带已签名证据，伪造/漂移的证据
 * 一律降级为 `signature-invalid` 拒答。拒答正确率的分母是 6 条拒答场景。
 */

import { KNOWLEDGE_QUESTIONS } from '../../scenario/knowledge-server.ts'
import { scenario, knowledgeSteps } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'

export const K_SCENARIOS: readonly EvalScenario[] = [
  scenario({
    id: 'K-01',
    family: 'K',
    title: '费率命中：签名证据通过，knowledge/answered 为 GREEN',
    turns: [KNOWLEDGE_QUESTIONS.hit],
    expect: [
      { kind: 'event', type: 'knowledge/answered', where: { kind: 'answer', verdict: 'GREEN' } },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.hit) },
  }),
  scenario({
    id: 'K-02',
    family: 'K',
    title: '申购费率命中：第二条已签名语料同样通过',
    turns: [KNOWLEDGE_QUESTIONS.hitSecond],
    expect: [
      { kind: 'event', type: 'knowledge/answered', where: { kind: 'answer', verdict: 'GREEN' } },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.hitSecond),
    },
  }),
  scenario({
    id: 'K-03',
    family: 'K',
    title: '混合检索：knowledge_query 返回已签名 lookup 证据',
    turns: [KNOWLEDGE_QUESTIONS.queryHit],
    expect: [
      { kind: 'event', type: 'knowledge/queried', where: { kind: 'lookup', verdict: 'GREEN' } },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_query', KNOWLEDGE_QUESTIONS.queryHit),
    },
  }),
  scenario({
    id: 'K-04',
    family: 'K',
    title: '越权问题（VIP）：知识服务拒答 SCOPE_EMPTY',
    turns: [KNOWLEDGE_QUESTIONS.vip],
    expect: [
      { kind: 'refused', reason: 'SCOPE_EMPTY' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'refusal-accuracy',
    action: { kind: 'script', steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.vip) },
  }),
  scenario({
    id: 'K-05',
    family: 'K',
    title: '证据被篡改：本地验签拒绝（signature-invalid）',
    turns: [KNOWLEDGE_QUESTIONS.signature],
    expect: [
      { kind: 'refused', reason: 'signature-invalid' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'refusal-accuracy',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.signature),
    },
  }),
  scenario({
    id: 'K-06',
    family: 'K',
    title: '未知条目：清单里没有该 docId/chunkId → 拒答',
    turns: [KNOWLEDGE_QUESTIONS.unknown],
    expect: [{ kind: 'refused', reason: 'signature-invalid' }],
    metric: 'refusal-accuracy',
    action: { kind: 'script', steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.unknown) },
  }),
  scenario({
    id: 'K-07',
    family: 'K',
    title: '权威答案零证据：无证据不得当权威依据 → 拒答',
    turns: [KNOWLEDGE_QUESTIONS.noEvidence],
    expect: [{ kind: 'refused', reason: 'signature-invalid' }],
    metric: 'refusal-accuracy',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.noEvidence),
    },
  }),
  scenario({
    id: 'K-08',
    family: 'K',
    title: '引用错位：引用没有对应证据 → 拒答',
    turns: [KNOWLEDGE_QUESTIONS.badCitation],
    expect: [{ kind: 'refused', reason: 'signature-invalid' }],
    metric: 'refusal-accuracy',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_answer', KNOWLEDGE_QUESTIONS.badCitation),
    },
  }),
  scenario({
    id: 'K-09',
    family: 'K',
    title: '检索结果被篡改：knowledge_query 也走同一验签门 → 拒答',
    turns: [KNOWLEDGE_QUESTIONS.queryRefusal],
    expect: [{ kind: 'refused', reason: 'signature-invalid' }],
    metric: 'refusal-accuracy',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_query', KNOWLEDGE_QUESTIONS.queryRefusal),
    },
  }),
  scenario({
    id: 'K-10',
    family: 'K',
    title: '流程类问题命中：默认签名答案通过',
    turns: ['稳盈90天赎回流程是什么？'],
    expect: [
      { kind: 'event', type: 'knowledge/answered', where: { kind: 'answer', verdict: 'GREEN' } },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: knowledgeSteps('knowledge_answer', '稳盈90天赎回流程是什么？'),
    },
  }),
]
