/**
 * 打印 `docs/web-frontend.md` §7 的路由表（W16）。
 *
 * 用法：`npx tsx scripts/web-routes.ts`
 *
 * 为什么要有这个脚本：路由表是契约，手写必然分叉。表由
 * `packages/host/src/boot/plugins/web/router.ts` 的 ROUTES 渲染，
 * `web/contract.test.ts` 负责判"文档里的表是否过期"（它跑在 CI 里，比人记得住）。
 */

import { renderRoutesMarkdown } from '../packages/host/src/boot/plugins/web/routes-markdown.ts'

process.stdout.write(`${renderRoutesMarkdown()}\n`)
