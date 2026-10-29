/**
 * 门禁 `tenant-scope` 的自检面（租户与鉴权 01 · TA-19-1）。
 *
 * 门禁本身必须有反例，否则它会变成"永远输出（无）"的那种脚本（R12 的血泪）。
 * 这里钉两件事：
 * 1. 内联坏样本**必须**被抓到（`selfTest()` 返回 0）；
 * 2. 误报面要窄——`${sessionId}#${epoch}` 是哈希输入不是路径，`query.tenant` 是领域对象。
 */

import { describe, expect, it } from 'vitest'

import {
  argumentAt,
  judgeBaseRootUse,
  judgeClientTenant,
  judgeMemoryArgs,
  judgeSessionPathJoin,
  selfTest,
  stripComments,
} from './verify-tenant-scope.ts'

describe('stripComments', () => {
  it('TA-19-1 去注释但保留字符串（判据 3 要看见 "x-tenant" 这个字面量）', () => {
    const source = "// headers['x-tenant']\nconst a = \"headers['x-tenant']\"\n/* 反例：join(root, sessionId) */\n"
    const stripped = stripComments(source)
    expect(stripped).not.toContain('反例')
    expect(stripped).toContain("headers['x-tenant']")
    expect(stripped).not.toContain('join(root, sessionId)')
  })
})

describe('argumentAt', () => {
  it('TA-19-2 顶层逗号切分：嵌套调用与字符串里的逗号不算分隔', () => {
    const source = 'readScoped(store, query.tenant, fn(a, b), { x: "a,b" })'
    const open = source.indexOf('(')
    expect(argumentAt(source, open, 0)?.text.trim()).toBe('store')
    expect(argumentAt(source, open, 1)?.text.trim()).toBe('query.tenant')
    expect(argumentAt(source, open, 2)?.text.trim()).toBe('fn(a, b)')
    expect(argumentAt(source, open, 9)).toBeUndefined()
  })
})

describe('判据 1 · 记忆 API 租户实参', () => {
  it('TA-19-3 缺租户 / 租户写错位都会红', () => {
    expect(judgeMemoryArgs('x.ts', 'store.listUnits(userId)')).toHaveLength(1)
    expect(judgeMemoryArgs('x.ts', 'readScoped(store, userId)')).toHaveLength(1)
  })

  it('TA-19-4 合法写法不红（大小写不敏感：TENANT 常量也算）', () => {
    expect(judgeMemoryArgs('x.ts', 'store.listUnits(tenant, userId)')).toEqual([])
    expect(judgeMemoryArgs('x.ts', 'store.listUnits(TENANT, USER)')).toEqual([])
    expect(judgeMemoryArgs('x.ts', 'readScoped(store, query.tenant, query.user_id, {})')).toEqual([])
  })
})

describe('判据 2 · host 拼会话路径', () => {
  it('TA-19-5 拼 sessionId 路径但整份文件没有 tenant → 红', () => {
    expect(
      judgeSessionPathJoin('packages/host/src/boot/plugins/x.ts', 'join(root, String(sessionId))'),
    ).toHaveLength(1)
  })

  it('TA-19-6 哈希输入不算拼路径（`${sessionId}#${epoch}` 是分桶键）', () => {
    expect(
      judgeSessionPathJoin(
        'packages/host/src/boot/plugins/x.ts',
        'sha256Hex(`${sessionId}#${String(epoch)}`)',
      ),
    ).toEqual([])
  })

  it('TA-19-7 只扫 packages/host/src（别处拼会话路径用别的判据）', () => {
    expect(judgeSessionPathJoin('packages/cli/src/x.ts', 'join(root, String(sessionId))')).toEqual([])
  })
})

describe('判据 3 · 禁止客户端声明租户', () => {
  it('TA-19-8 请求头与查询参数两条路都红', () => {
    expect(judgeClientTenant('x.ts', "req.headers['x-tenant']")).toHaveLength(1)
    expect(judgeClientTenant('x.ts', "url.searchParams.get('tenant')")).toHaveLength(1)
  })

  it('TA-19-9 领域查询对象（记忆的 query.tenant）不误报', () => {
    expect(judgeClientTenant('x.ts', 'planRoute(query) // query.tenant 是领域字段')).toEqual([])
  })
})

describe('selfTest', () => {
  it('TA-19-10 内联坏样本全部被抓、合法样本不被误报', () => {
    expect(selfTest()).toBe(0)
  })
})

describe('判据 4 · baseRoot 只许 saga-store 用（AR-04）', () => {
  it('AR-04-1 新插件用 baseRoot → 红（部署根是这条边界上唯一的官方豁口）', () => {
    const findings = judgeBaseRootUse(
      'packages/host/src/boot/plugins/fake-sink.ts',
      'const dir = ctx.get(SESSION_FILES).baseRoot\n',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('baseRoot')
  })

  it('AR-04-2 定义处与唯一使用者不红（白名单是精确路径，不通配）', () => {
    const source = 'const dbPath = resolve(ctx.get(SESSION_FILES).baseRoot, config.dbPath)\n'
    expect(judgeBaseRootUse('packages/host/src/boot/plugins/saga-store.ts', source)).toEqual([])
    expect(judgeBaseRootUse('packages/host/src/boot/plugins/persistence.ts', 'readonly baseRoot: string')).toEqual([])
  })

  it('AR-04-3 不碰 baseRoot 的文件不参与（判据不该对无关文件发声）', () => {
    expect(judgeBaseRootUse('packages/host/src/boot/plugins/memory.ts', 'const root = files.root')).toEqual([])
  })
})
