/**
 * RAG sidecar 的演示 token（唯一解析点）。
 *
 * 为什么要统一：sidecar 是 **fail-loud** —— `Authenticator` 构造时既没有
 * `BAH_RAG_TOKEN_SECRET` 也没有 `BAH_RAG_TOKEN` / `BAH_KNOWLEDGE_TOKEN` 就直接抛
 * `RuntimeError: 认证未配置`。而 host 侧 `bank:knowledge` 默认从
 * `BAH_KNOWLEDGE_TOKEN` 读 Bearer；两边各自生成随机 token 会得到 401。
 *
 * 纪律：
 * 1. 环境里已有 token → 原样使用（CI / 手工联调可固定）；
 * 2. 没有 → 生成本次进程的一次性 token；**不落盘**，也不写进任何日志文件；
 * 3. `rag:dev` 单独启动时打印一次（否则用户无法把同一 token 交给 host）；
 *    `demo:rag` 由脚本把同一 token 同时注入 sidecar 与 host，不打印明文。
 */

import { randomBytes } from 'node:crypto'

/** host 的默认 `tokenEnv`；也是 sidecar 的 legacy 演示 token 变量。 */
export const KNOWLEDGE_TOKEN_ENV = 'BAH_KNOWLEDGE_TOKEN'

/** sidecar 的新演示 token 变量（优先级高于 legacy，见 auth.py）。 */
export const RAG_TOKEN_ENV = 'BAH_RAG_TOKEN'

/** 已配置的 token（去空白）；两个变量都没有则 undefined。 */
export function existingDemoToken(env = process.env) {
  const knowledge = env[KNOWLEDGE_TOKEN_ENV]
  const rag = env[RAG_TOKEN_ENV]
  const knowledgeToken =
    typeof knowledge === 'string' && knowledge.trim() !== '' ? knowledge.trim() : undefined
  const ragToken = typeof rag === 'string' && rag.trim() !== '' ? rag.trim() : undefined

  // 两边都设且不一致：sidecar 优先读 BAH_RAG_TOKEN，host 默认读 BAH_KNOWLEDGE_TOKEN，
  // 必然 401。与其到演示现场才发现，不如启动前直接说清。
  if (knowledgeToken !== undefined && ragToken !== undefined && knowledgeToken !== ragToken) {
    throw new Error(
      `${KNOWLEDGE_TOKEN_ENV} 与 ${RAG_TOKEN_ENV} 都已设置但不一致：sidecar 会优先用 ` +
        `${RAG_TOKEN_ENV}，host 默认用 ${KNOWLEDGE_TOKEN_ENV}，两者必然 401。` +
        '请只设置一个，或把两个变量设成同一个值。',
    )
  }

  return knowledgeToken ?? ragToken
}

/**
 * 解析本次运行要用的 token。
 *
 * @returns {{ token: string, generated: boolean, source: 'env' | 'generated' }}
 */
export function resolveDemoToken(env = process.env) {
  const existing = existingDemoToken(env)
  if (existing !== undefined) return { token: existing, generated: false, source: 'env' }
  return {
    token: `bah-demo-${randomBytes(18).toString('base64url')}`,
    generated: true,
    source: 'generated',
  }
}

/**
 * 单独启动 sidecar 时把 token 交给用户（仅 stderr，不写文件）。
 *
 * 只在 token 是本次生成时调用；环境里已有的 token 不重复打印。
 */
export function printTokenHint(token) {
  console.error(
    [
      '[rag] 未设置 BAH_KNOWLEDGE_TOKEN / BAH_RAG_TOKEN：已生成本次一次性演示 token（不落盘，重启即变）。',
      `[rag] host 侧必须使用同一 token：${KNOWLEDGE_TOKEN_ENV}=${token}`,
      '[rag] 不要把上面这行贴进截图 / 入库日志；更省事的方式：pnpm demo:rag（一条命令注入同一 token）。',
    ].join('\n'),
  )
}
