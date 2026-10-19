/**
 * 测试用执行体：改写传入的投影数据（T-SBX-008，验证"只读投影"）。
 *
 * worker 拿到的是结构化克隆，所以这里改得动、主进程却看不见——夹具故意去改，
 * 就是为了让"改不动"这件事被钉成用例。
 */

export const SANDBOX_HANDLER = {
  key: 'mutate',
  capabilities: [] as const,
  run: (payload: unknown): number => {
    const request = payload as { data: { probe: number } }
    request.data.probe = 999
    return request.data.probe
  },
}
