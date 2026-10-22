/**
 * 门管线（施工文档 §5）：通道隔离 → 注入门 → 抽取 → 结构/依据/敏感门 → 写入或分流。
 *
 * **刻意偏离文档顺序**：文档把 G4 排在逐条过门里（第 4 道）。这里把它提到**解析之前**，
 * 理由有二：
 *   1. 不可信输入不该进正则解析器——先拒再解析，比"解析完再把每条候选拒掉"少一条
 *      被规则漏洞吃掉的路（P1 的正则能匹配到注入句的一部分，此时逐条拒会产生
 *      "部分候选被拒、部分写进去"的分裂状态）；
 *   2. D3 的 10 条注入用例里有"忽略之前的指令"这类**抽不出任何候选**的句子，
 *      逐条过门只会得到 `EXTRACT_NO_CANDIDATE`，拿不到 `GATE_INJECTION` 这个信号。
 *
 * 代价：一句正常话里夹了一句注入，会整句丢弃（包括其中合法的偏好）。这是**故意选的
 * 安全侧**——宁可让用户重说一遍偏好，也不能让攻击句和偏好一起落库。
 */

import { contentHash } from '../hash.ts'
import { memoryUnitId } from '../ids.ts'
import { extractCandidates } from '../extract/rules.ts'
import { BASIS_BY_PREDICATE } from '../words.ts'
import { checkBasis } from './basis.ts'
import { checkInjection } from './injection.ts'
import { checkSensitivity } from './sensitivity.ts'
import { checkStructure } from './structure.ts'

import type { MemoryStore, MemoryUnitRow } from '../store/index.ts'
import type { ProceduralVault } from '../vault/procedural.ts'
import type { GateResult, IngestInput, IngestResult, MemoryCandidate, Provenance } from '../types.ts'

export interface PipelineOptions {
  readonly store: MemoryStore
  readonly vault: ProceduralVault
  readonly now: () => number
  /** 本部署允许的最高敏感级；个人客户默认 S2（§7.2）。 */
  readonly sensitivityCeiling?: number
}

const DEFAULT_SENSITIVITY_CEILING = 2

/** 通道隔离：非用户通道一律不产生候选（ATK-22 / A8 / A9）。 */
function channelRejected(input: IngestInput): GateResult {
  return {
    // 专用码而不是 `EXTRACT_NO_CANDIDATE`：审计要能一眼分清"越权通道"与"没抽到东西"。
    code: 'CHANNEL_REJECTED',
    reason: `speaker=${input.speaker} 不是用户通道，内容不进入记忆管道`,
  }
}

export async function ingestTurn(input: IngestInput, options: PipelineOptions): Promise<IngestResult> {
  const ts = new Date(options.now()).toISOString()
  const rejected: GateResult[] = []
  const superseded: string[] = []
  const vaultPending: string[] = []
  const written: string[] = []

  // 1) 通道隔离。位置在抽取之前：工具输出、模型输出、文档内容都没有"用户说过"的资格。
  if (input.speaker !== 'user') {
    return {
      candidates: 0,
      written: 0,
      superseded: [],
      vaultPending: [],
      rejected: [channelRejected(input)],
    }
  }

  // 2) 整句注入门（见文件头：刻意前置）。
  const injection = checkInjection(input.text, ts)
  if (injection.code === 'GATE_INJECTION') {
    return {
      candidates: 0,
      written: 0,
      superseded: [],
      vaultPending: [],
      rejected: [injection],
    }
  }

  // 3) 规则抽取。
  const extraction = extractCandidates(input)
  for (const item of extraction.unresolved) {
    rejected.push({
      code: 'EXTRACT_SUBJECT_UNRESOLVED',
      reason: `${item.family} 主体未能解析：${item.suggestion}`,
    })
  }
  // 零静默：一条候选都没抽到，也要留下**为什么**是一条记录，而不是一个空数组。
  // 这条码在 `GateCode` 里声明了却长期没人产出，本身就是"声明了但不兑现"的审计缺口。
  if (extraction.memories.length === 0 && extraction.vaults.length === 0 && extraction.unresolved.length === 0) {
    rejected.push({ code: 'EXTRACT_NO_CANDIDATE', reason: '未命中 P1–P4 任何抽取模式（正常路径）' })
  }

  const provenanceBase = (pattern: MemoryCandidate['pattern']): Provenance => ({
    session_id: input.session_id,
    turn_id: input.turn_id,
    pipeline: { extractor: 'rules@v1', pattern },
  })

  // 4) KV 候选逐条过门。
  for (const candidate of extraction.memories) {
    const gate = runMemoryGates(candidate, options, ts)
    if (gate.result.code !== 'PASS') {
      rejected.push(gate.result)
      continue
    }

    const object = gate.object
    const hash = contentHash({
      tenant: input.tenant,
      userId: input.user_id,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object,
    })

    if (options.store.findUnitByHash(input.tenant, input.user_id, hash) !== undefined) {
      // 幂等：同一条记忆说了两遍不是两条记忆。
      rejected.push({ code: 'IDEMPOTENT_SKIP', reason: '同内容记忆已存在（content_hash 命中）' })
      continue
    }

    const actives = options.store.listActiveUnits(
      input.tenant,
      input.user_id,
      candidate.subject,
      candidate.predicate,
    )
    // 无条件淘汰同键全部现行行。理由：能走到这里说明 `content_hash` 没命中（幂等已挡），
    // 即这条记忆的内容与库里任何一条都不同；同一 (subject, predicate) 出现两个不同值时，
    // 新的就是唯一的现行版本。留一条旧的 active 会让读取召回自相矛盾的两个答案。
    const supersededIds = actives.map((row) => row.unitId)

    const basis = BASIS_BY_PREDICATE.get(candidate.predicate)
    const whitelist = basis?.sceneWhitelist ?? [candidate.scene]
    const row: MemoryUnitRow = {
      unitId: memoryUnitId(options.now()),
      tenant: input.tenant,
      userId: input.user_id,
      unitType: basis?.unitType ?? 'entity_fact',
      // 首位=**来源场景**，其余=可被召回的场景（`sourceScene` 靠首位还原，见 `read/render.ts`）。
      sceneTags: [candidate.scene, ...whitelist.filter((scene) => scene !== candidate.scene)],
      sensitivity: basis?.allowedSensitivity ?? 1,
      state: 'active',
      subject: candidate.subject,
      predicate: candidate.predicate,
      object,
      validFrom: ts,
      validTo: null,
      supersededBy: null,
      sourceType: candidate.source,
      confidence: candidate.confidence,
      provenance: provenanceBase(candidate.pattern),
      contentHash: hash,
      createdAt: ts,
      lastVerifiedAt: null,
    }
    options.store.writeUnit(row, supersededIds)
    written.push(row.unitId)
    superseded.push(...supersededIds)
  }

  // 5) 程序性候选入金库：只到 pending_confirm，不碰 KV 表。
  for (const vaultCandidate of extraction.vaults) {
    const procId = options.vault.submit(vaultCandidate, {
      tenant: input.tenant,
      userId: input.user_id,
      sessionId: input.session_id,
      provenance: provenanceBase('P4'),
    })
    vaultPending.push(procId)
    rejected.push({
      code: 'ROUTE_VAULT_PENDING',
      reason: '程序性指令进入金库待确认，未写入记忆库',
    })
  }

  const candidateCount = extraction.memories.length + extraction.vaults.length
  return {
    candidates: candidateCount,
    written: written.length,
    superseded,
    vaultPending,
    rejected,
  }
}

function runMemoryGates(
  candidate: MemoryCandidate,
  options: PipelineOptions,
  ts: string,
): { result: GateResult; object: unknown } {
  const structure = checkStructure(candidate)
  if (structure.code !== 'PASS') return { result: structure, object: candidate.object }

  const basis = checkBasis(candidate.predicate, options.sensitivityCeiling ?? DEFAULT_SENSITIVITY_CEILING)
  if (basis.code !== 'PASS') return { result: basis, object: candidate.object }

  const sensitivity = checkSensitivity(candidate)
  if (sensitivity.result.code !== 'PASS') return { result: sensitivity.result, object: candidate.object }

  return { result: { code: 'PASS' }, object: sensitivity.object }
}
