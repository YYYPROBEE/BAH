/**
 * W11 计划模板层：整串识别、递归收集、执行期替换。
 *
 * 直测本文件而不是只靠 engine 集成：数组入参此前**零覆盖**，
 * 而 `resolveTemplateArgs` 的失败语义（部分解析 + `ok=false`）决定
 * 引擎会不会把字面量 `${node.x.y}` 当金额派发给工具。
 */

import { describe, expect, it } from 'vitest'

import { collectTemplateRefs, resolveTemplateArgs, templateRefOf } from './template.ts'

describe('templateRefOf：只认整串模板', () => {
  it('整串 `${node.<id>.<path>}` → 解析出 id 与点分路径', () => {
    expect(templateRefOf('${node.a.txnId}')).toEqual({
      nodeId: 'a',
      path: ['txnId'],
      raw: 'a.txnId',
    })
    expect(templateRefOf('${node.a.content.0.text}')).toMatchObject({
      nodeId: 'a',
      path: ['content', '0', 'text'],
    })
  })

  it('前后缀拼接 / 多模板 / 嵌套模板都不是模板（按字面量原样传下去）', () => {
    expect(templateRefOf('前缀-${node.a.x}')).toBeUndefined()
    expect(templateRefOf('${node.a.x}-后缀')).toBeUndefined()
    expect(templateRefOf('${node.a.x}${node.b.y}')).toBeUndefined()
    expect(templateRefOf('${node.a.${b}}')).toBeUndefined()
    expect(templateRefOf('${a + b}')).toBeUndefined()
  })

  it('空路径段与非法节点 id 退回字面量，不猜下标', () => {
    expect(templateRefOf('${node.a.}')).toBeUndefined()
    expect(templateRefOf('${node.a..b}')).toBeUndefined()
    expect(templateRefOf('${node.a b.x}')).toBeUndefined()
    expect(templateRefOf('${node..x}')).toBeUndefined()
  })

  it('非字符串一律不是模板', () => {
    for (const value of [42, null, undefined, true, { nodeId: 'a' }, ['${node.a.x}']]) {
      expect(templateRefOf(value)).toBeUndefined()
    }
  })
})

describe('collectTemplateRefs：递归与确定性', () => {
  it('对象按字典序、数组按元素顺序收集，只认字符串叶子', () => {
    const refs = collectTemplateRefs({
      z: '${node.c.y}',
      a: { b: '${node.d.x}', a: '${node.e.w}' },
      n: 1,
    })
    expect(refs.map((ref) => ref.raw)).toEqual(['e.w', 'd.x', 'c.y'])
  })

  it('数组里的模板也要被校验（此前数组分支未被任何用例走到）', () => {
    const refs = collectTemplateRefs({ items: ['${node.a.x}', 'literal', ['${node.b.y}']] })
    expect(refs.map((ref) => ref.raw)).toEqual(['a.x', 'b.y'])
  })

  it('没有模板 → 空数组', () => {
    expect(collectTemplateRefs({ a: 'x', b: [1, 2], c: { d: null } })).toEqual([])
  })
})

describe('resolveTemplateArgs：整值替换与失败语义', () => {
  it('整值替换保留类型（number 不会变成字符串）', () => {
    const args: Readonly<Record<string, unknown>> = { amount: '${node.a.amount}' }
    const resolution = resolveTemplateArgs(args, new Map([['a', { amount: 800 }]]))
    expect(resolution.ok).toBe(true)
    expect(resolution.args).toEqual({ amount: 800 })
    expect(typeof (resolution.args as Record<string, unknown>)['amount']).toBe('number')
  })

  it('数组元素与嵌套对象里的模板都会被替换', () => {
    const args: Readonly<Record<string, unknown>> = {
      items: ['${node.a.x}', 'literal', { deep: '${node.b.y}' }],
      filter: { min: '${node.a.x}' },
    }
    const resolution = resolveTemplateArgs(
      args,
      new Map<string, unknown>([
        ['a', { x: 7 }],
        ['b', { y: 'ok' }],
      ]),
    )
    expect(resolution.ok).toBe(true)
    expect(resolution.args).toEqual({ items: [7, 'literal', { deep: 'ok' }], filter: { min: 7 } })
  })

  it('无模板时原样返回同一个对象（引擎据引用相等避免重建节点）', () => {
    const args: Readonly<Record<string, unknown>> = { a: 1, b: ['x'], c: { d: true } }
    const resolution = resolveTemplateArgs(args, new Map())
    expect(resolution.ok).toBe(true)
    expect(resolution.args).toBe(args)
  })

  it('路径穿不过去 → ok=false、保留原字面量并登记 unresolved', () => {
    const args: Readonly<Record<string, unknown>> = { v: '${node.a.missing}' }
    const resolution = resolveTemplateArgs(args, new Map([['a', { other: 1 }]]))
    expect(resolution.ok).toBe(false)
    expect(resolution.args).toEqual(args)
    expect(resolution.unresolved.map((ref) => ref.raw)).toEqual(['a.missing'])
  })

  it('null / 原始值中段、字段值为 undefined 都算失败（不返回 undefined 冒充成功）', () => {
    const nullMid = resolveTemplateArgs({ v: '${node.a.x.y}' }, new Map([['a', { x: null }]]))
    expect(nullMid.ok).toBe(false)

    const primitiveMid = resolveTemplateArgs({ v: '${node.a.x.y}' }, new Map([['a', { x: 1 }]]))
    expect(primitiveMid.ok).toBe(false)

    const undefinedValue = resolveTemplateArgs({ v: '${node.a.x}' }, new Map([['a', { x: undefined }]]))
    expect(undefinedValue.ok).toBe(false)
  })

  it('数组下标只认规范十进制：0 可读，01 / -1 / x / 越界一律失败', () => {
    const outputs = new Map<string, unknown>([['a', { content: [{ text: 'hi' }] }]])
    const read = (path: string) => resolveTemplateArgs({ v: `\${node.a.${path}}` }, outputs)

    expect(read('content.0.text').args).toEqual({ v: 'hi' })
    expect(read('content.01.text').ok).toBe(false)
    expect(read('content.-1.text').ok).toBe(false)
    expect(read('content.x.text').ok).toBe(false)
    expect(read('content.9.text').ok).toBe(false)
  })

  it('只认自有属性：原型链上的键不能被模板读到', () => {
    const inherited = Object.create({ secret: 'leak' }) as Record<string, unknown>
    const resolution = resolveTemplateArgs(
      { v: '${node.a.secret}' },
      new Map([['a', inherited]]),
    )
    expect(resolution.ok).toBe(false)

    const plain = resolveTemplateArgs({ v: '${node.a.toString}' }, new Map([['a', {}]]))
    expect(plain.ok).toBe(false)
  })

  it('部分解析：一条成功一条失败 → ok=false，成功的那条仍被替换（调用方不得执行）', () => {
    const resolution = resolveTemplateArgs(
      { ok: '${node.a.x}', bad: '${node.missing.y}' },
      new Map([['a', { x: 1 }]]),
    )
    expect(resolution.ok).toBe(false)
    expect(resolution.args).toEqual({ ok: 1, bad: '${node.missing.y}' })
    expect(resolution.unresolved).toHaveLength(1)
  })

  it('非模板字符串保持字面量，不报错也不执行表达式', () => {
    const args: Readonly<Record<string, unknown>> = {
      a: '${a + b}',
      b: '前缀-${node.a.x}',
      c: '${node.a.x}${node.b.y}',
    }
    const resolution = resolveTemplateArgs(args, new Map([['a', { x: 1 }]]))
    expect(resolution.ok).toBe(true)
    expect(resolution.args).toBe(args)
  })
})
