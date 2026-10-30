/**
 * 审查探针 A：变异测试（证明用例不是空跑）。
 * 每个变异：改一处实现 → 跑对应用例 → 必须红 → 从内存原样还原并校验哈希。
 * 一次性脚本，跑完即删。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const root = 'D:/项目集/微众杯银行ai智能体/BAH/MonoRepo'
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const cases = [
  {
    name: 'M1 白名单去掉 choice（复原 P0）',
    file: 'apps/web/src/views/conversation.js',
    from: "['turn', 'message', 'notice', 'tool', 'choice', 'effects']",
    to: "['turn', 'message', 'notice', 'tool', 'effects']",
    tests: ['apps/web/src/main.test.js'],
  },
  {
    name: 'M2 点选发送 id 而不是 label',
    file: 'apps/web/src/views/choice-card.js',
    from: 'onclick: () => void pick(option.label),',
    to: 'onclick: () => void pick(option.id),',
    tests: ['apps/web/src/views/choice-card.test.js'],
  },
  {
    name: 'M3 去掉 choice 视图键的 seq（退回 callId 合并）',
    file: 'apps/web/src/store.js',
    from: "  if (frame.kind === 'choice') return `choice:${frame.callId}:${frame.seq}`\n",
    to: '',
    tests: ['apps/web/src/store.test.js', 'apps/web/src/main.test.js'],
  },
  {
    name: 'M4 renderFrame 不接 effects',
    file: 'apps/web/src/views/conversation.js',
    from: "    case 'effects':\n      return renderEffects(frame)\n",
    to: '',
    tests: ['apps/web/src/main.test.js'],
  },
  {
    name: 'M5 effects 卡塞一个"撤销"按钮（破只读）',
    file: 'apps/web/src/views/effects.js',
    from: "      el('ul', { class: 'effects__list' }, items),",
    to: "      el('ul', { class: 'effects__list' }, items),\n      el('button', { text: '撤销' }),",
    tests: ['apps/web/src/views/effects.test.js'],
  },
  {
    name: 'M6 手动输入改成直接发消息',
    file: 'apps/web/src/views/choice-card.js',
    from: 'onclick: () => focusComposer?.(),',
    to: "onclick: () => void pick('手动输入'),",
    tests: ['apps/web/src/views/choice-card.test.js'],
  },
]

let survived = 0
for (const item of cases) {
  const path = `${root}/${item.file}`
  const original = readFileSync(path, 'utf8')
  const hash0 = sha(original)
  // 兼容 CRLF：同一个变异准备两种换行形态，取唯一命中的那一种
  const crlf = original.includes('\r\n')
  const from = crlf ? item.from.replace(/\n/g, '\r\n') : item.from
  const to = crlf ? item.to.replace(/\n/g, '\r\n') : item.to
  const occurrences = original.split(from).length - 1
  if (occurrences !== 1) {
    console.log(`SETUP-FAIL ${item.name}: 匹配 ${String(occurrences)} 次（应为 1，CRLF=${String(crlf)}）`)
    survived += 1
    continue
  }
  writeFileSync(path, original.replace(from, to))
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--config', 'vitest.web.config.ts', ...item.tests],
    { cwd: root, shell: true, encoding: 'utf8', timeout: 180000 },
  )
  writeFileSync(path, original)
  const restored = sha(readFileSync(path, 'utf8')) === hash0
  const caught = result.status !== 0
  if (!caught) survived += 1
  const tail = String(result.stdout ?? '')
    .split('\n')
    .filter((line) => /Test Files|Tests\s|FAIL/.test(line))
    .slice(-3)
    .join(' | ')
  console.log(`${caught ? 'CAUGHT' : 'SURVIVED'} ${item.name} · exit=${String(result.status)} · restored=${String(restored)} · ${tail}`)
}

console.log(`\n变异 ${String(cases.length)} 个，未捕获 ${String(survived)} 个`)
process.exitCode = survived === 0 ? 0 : 1
