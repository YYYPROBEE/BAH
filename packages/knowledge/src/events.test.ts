import { describe, expect, it } from 'vitest'

import { KNOWLEDGE_EVENT_TYPES } from './events.ts'

describe('knowledge events', () => {
  it('declares both durable event names', () => {
    expect(KNOWLEDGE_EVENT_TYPES).toEqual(['knowledge/answered', 'knowledge/queried'])
  })
})
