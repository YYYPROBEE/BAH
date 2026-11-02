/**
 * `prompt_ask` 的出参契约。
 *
 * 三条口径照抄 `bank/result-schemas.ts` 头注释：
 * 金额一律 integer 分；领域枚举只写 `type:'string'`；不设 `additionalProperties:false`。
 */

import type { ToolSchema } from '@bah/core'

export const PROMPT_ASK_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
    allowFreeText: { type: 'boolean' },
    degraded: { type: 'boolean' },
    askExhausted: { type: 'boolean' },
  },
  required: ['question', 'choices', 'allowFreeText', 'degraded', 'askExhausted'],
} satisfies ToolSchema
