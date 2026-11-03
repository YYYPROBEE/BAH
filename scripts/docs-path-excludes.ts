/**
 * `verify-docs-paths` 的例外名单。
 *
 * 只收**运行期目录与构建产物**：干净 clone 上本来就不存在，文档里以路径形式
 * 提到它们是排障线索，不是声称仓库里有这些文件。
 *
 * 纪律：
 * - 已实装包里的失效引用是**真 bug**：改文档，不许进名单。
 * - 实装之后必须删掉对应条目，否则门禁就成了"规划永动机"的挡箭牌。
 */

export interface DocsPathExclusion {
  /** 相对仓库根的 posix 路径。 */
  readonly path: string
  /** 为什么引用一个不存在的路径是合法的。 */
  readonly why: string
}

export const DOCS_PATH_EXCLUSIONS: readonly DocsPathExclusion[] = [
  // 运行期目录：内容一律不入库（`*.sqlite` 知识库、fastembed 模型缓存），
  // 干净 clone 上本就不该有 —— `store.py:202` 自建父目录，容器按 `-v` 挂载宿主目录。
  {
    path: 'services/rag/data',
    why: '运行期数据目录：内容是本地知识库（*.sqlite 已忽略），store.py 自建父目录、容器按 -v 挂载，干净 clone 上不该有',
  },
  {
    path: 'services/rag/models',
    why: '运行期模型缓存目录：fastembed 首次运行自建，内容不入库',
  },
  {
    path: 'services/rag/models/',
    why: '同上；门禁按精确串匹配，文档里带尾斜杠的写法需单列',
  },
  // 构建产物：`.gitignore` 忽略 `dist/`，只有 `pnpm build` 之后才存在。
  // 文档里写它是"旧 dist 会造成 .js 回退"排障线索，不是声称仓库里有这个目录。
  {
    path: 'packages/cli/dist',
    why: 'CLI 构建产物目录：`pnpm build` 从 packages/cli/bundles/base/index.ts 转译生成，dist/ 已忽略，干净 clone 上不该有',
  },
]
