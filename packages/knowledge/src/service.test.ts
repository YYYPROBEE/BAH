import { describe, expect, it } from 'vitest'

import { KNOWLEDGE_SERVICE } from './service.ts'

describe('knowledge service key', () => {
  it('is addressable by the documented id', () => {
    expect(KNOWLEDGE_SERVICE.id).toBe('bank:knowledge')
  })
})
