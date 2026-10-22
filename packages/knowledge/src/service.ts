import { defineService } from '@bah/core'

import type { KnowledgePort } from './port.ts'

/** 知识平面服务键：宿主与渠道只按键寻址，不认 HTTP/fixture 实现。 */
export const KNOWLEDGE_SERVICE = defineService<KnowledgePort>('bank:knowledge')
