import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TrajectoryRecorder } from '../../src/recorder/TrajectoryRecorder.ts'
import { dropRunsDir, FIXED_TS, makeRunsDir } from '../helpers/fixtures.ts'

const clock = (): Date => new Date(FIXED_TS)

describe('TrajectoryRecorder', () => {
  let runsDir: string

  beforeEach(async () => {
    runsDir = await makeRunsDir()
  })

  afterEach(async () => {
    await dropRunsDir(runsDir)
  })

  it('begin / appendTool / end 追加写 JSONL，seq 单调递增', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })

    await recorder.begin()
    const first = await recorder.appendTool({ tool: 'verify_face', args: { channel: 'face' } })
    const second = await recorder.appendTool({ tool: 'transfer_create', args: { amount: 100 } })
    await recorder.end('success')

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(first.ts).toBe(FIXED_TS)

    const lines = (await readFile(recorder.trajectoryPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ record: 'episode-start', seq: 0 })
    expect(JSON.parse(lines[3] ?? '')).toMatchObject({ record: 'episode-end', outcome: 'success' })
  })

  it('出口脱敏：落盘文件里不含卡号/证件/手机号原文', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    await recorder.appendTool({
      tool: 'transfer_create',
      args: { cardNo: '6222021234567890123', idNo: '11010119900307123X', phone: '13800138000' },
      result: { isError: false, reason: 'ok 13800138000' },
    })
    await recorder.end('success')

    const content = await readFile(recorder.trajectoryPath, 'utf8')
    expect(content).not.toContain('6222021234567890123')
    expect(content).not.toContain('11010119900307123X')
    expect(content).not.toContain('13800138000')
    expect(content).toMatch(/CARD-[0-9a-f]{8}/)
    expect(content).toMatch(/ID-[0-9a-f]{8}/)
    expect(content).toMatch(/TEL-[0-9a-f]{8}/)
  })

  it('幂等键与权限分支原样带入事件', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const event = await recorder.appendTool({
      tool: 'transfer_create',
      args: {},
      idempotencyKey: 'idem-1',
      permissionBranch: 'approval-allowed-once',
    })

    expect(event.idempotencyKey).toBe('idem-1')
    expect(event.permissionBranch).toBe('approval-allowed-once')
  })

  it('events 只返回工具事件（不含起止标记）', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    await recorder.appendTool({ tool: 'a', args: {} })
    await recorder.end('failure')

    expect(recorder.events).toHaveLength(1)
    expect(recorder.events[0]?.tool).toBe('a')
    expect(recorder.records).toHaveLength(3)
  })

  it('并发 appendTool 不交错（调用方忘了 await 也不坏行）', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()

    // 故意不逐个 await：这是最常见的误用。没有内部写队列时，多次 appendFile
    // 会互相穿插，落盘变成两行半截 JSON。
    const pending = Array.from({ length: 25 }, (_, index) =>
      recorder.appendTool({ tool: `tool_${String(index)}`, args: { index } }),
    )
    await Promise.all(pending)
    await recorder.end('success')

    const lines = (await readFile(recorder.trajectoryPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(27)

    const parsed = lines.map(
      (line) => JSON.parse(line) as { record: string; event?: { seq: number; tool: string } },
    )
    // 每一行都能独立解析 = 没有半截行；seq 严格递增 = 写入顺序等于调用顺序。
    expect(parsed[1]?.event).toMatchObject({ seq: 1, tool: 'tool_0' })
    expect(parsed[25]?.event).toMatchObject({ seq: 25, tool: 'tool_24' })
    expect(parsed[26]?.record).toBe('episode-end')
  })

  it('未 begin 就记录工具调用直接抛（不静默吞掉）', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await expect(recorder.appendTool({ tool: 'a', args: {} })).rejects.toThrow(/未 begin/)
  })

  it('重复 begin 抛', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    await expect(recorder.begin()).rejects.toThrow(/重复调用/)
  })

  it('end 之后再写入抛（防止轨迹在终点后继续增长）', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    await recorder.end('success')
    await expect(recorder.appendTool({ tool: 'a', args: {} })).rejects.toThrow(/已 end/)
  })

  it('重复 end 抛', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    await recorder.end('success')
    await expect(recorder.end('success')).rejects.toThrow(/重复调用/)
  })

  it('未 begin 就 end 抛', async () => {
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await expect(recorder.end('success')).rejects.toThrow(/未 begin/)
  })
})
