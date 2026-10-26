/**
 * 把 `docs/architecture.md` 里的 mermaid 块渲染成 PNG（W19 出口 1 的"png 进 PPT"）。
 *
 * ## 为什么渲染器不在依赖里
 *
 * 仓库的硬约束是**零外部运行时依赖**（R-2）。mermaid 只用于"生成一张图片"，
 * 不该为它往 `package.json` 里加一个 3 MB 的前端库。所以这里走"外部渲染器"路线：
 * 你给一个 mermaid 的 UMD 包路径，脚本用本机 Edge 无头渲染。
 *
 * ```bash
 * # 一次准备（不入库，.tmp-* 已在 .gitignore 里）
 * curl -sSL -o .tmp-w19/mermaid.min.js https://unpkg.com/mermaid@11/dist/mermaid.min.js
 * MERMAID_JS=.tmp-w19/mermaid.min.js npx tsx scripts/render-diagrams.ts
 * ```
 *
 * 缺渲染器时**不静默跳过**：直接退出码 1 并打印上面两行——"图没生成"必须看得见。
 *
 * ## 输出
 *
 * - `docs/diagrams/architecture-registry.png`（注册表图，宽幅 LR）
 * - `docs/diagrams/architecture-assembly.png`（装配差异图，纵向 TB）
 *
 * 尺寸在下面 `DIAGRAMS` 里写死：mermaid 的布局尺寸依赖内容，脚本不去猜，
 * 也不做裁剪（裁剪会引入"图片和源码不同步"的第二套逻辑）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { projectRoot } from './gate-lib.ts'

/** 一张要渲染的图。 */
interface DiagramPlan {
  /** 输出文件名（不含扩展名）。 */
  readonly name: string
  /** 章节标题（只用于日志）。 */
  readonly title: string
  /** 画布尺寸（像素）。 */
  readonly width: number
  readonly height: number
}

/** 两张图的画布尺寸：LR 图更宽，TB 图更高。 */
const DIAGRAMS: readonly DiagramPlan[] = [
  { name: 'architecture-dependencies', title: '依赖图（inject → provider）', width: 2400, height: 1500 },
  { name: 'architecture-assembly', title: '装配差异图（三个 profile）', width: 1700, height: 900 },
]

const root = projectRoot()

/** Edge 的两个常见安装位置（x86 优先，与 `where msedge` 的顺序一致）。 */
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

/** 找 Edge；找不到就 fail-loud。 */
function edgePath(): string {
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('找不到 msedge.exe（本脚本用本机 Edge 的无头截图渲染 mermaid）')
}

/** 从文档里按顺序取出 mermaid 块。 */
function mermaidBlocks(text: string): string[] {
  const blocks: string[] = []
  const pattern = /```mermaid\n([\s\S]*?)```/g
  for (const match of text.matchAll(pattern)) blocks.push(match[1] ?? '')
  return blocks
}

/** 生成一个只含一张图的 HTML。 */
function pageOf(source: string, mermaidJs: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body { margin:0; padding:24px; background:#ffffff; }
  .mermaid { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  /* mermaid 会把文本放进 <text>/<tspan>，themeVariables 的 fontFamily 不一定作用到节点标签，
     中文会退化成方块。这里用 !important 直接压到位。 */
  svg text, svg tspan, svg .nodeLabel, svg .edgeLabel {
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif !important;
  }
</style>
<script src="file:///${mermaidJs.replace(/\\/g, '/')}"></script>
</head><body>
<pre class="mermaid">
${source}
</pre>
<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: 'neutral',
    themeVariables: { fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif', fontSize: '15px' },
    flowchart: { htmlLabels: true, useMaxWidth: false, nodeSpacing: 34, rankSpacing: 90 },
  })
</script>
</body></html>`
}

/** 主流程。 */
function main(): void {
  const mermaidJs = resolve(root, process.env['MERMAID_JS'] ?? '.tmp-w19/mermaid.min.js')
  if (!existsSync(mermaidJs)) {
    console.error('✘ 缺 mermaid 渲染器。先准备一次：')
    console.error('    curl -sSL -o .tmp-w19/mermaid.min.js https://unpkg.com/mermaid@11/dist/mermaid.min.js')
    console.error('    MERMAID_JS=.tmp-w19/mermaid.min.js npx tsx scripts/render-diagrams.ts')
    process.exitCode = 1
    return
  }

  const blocks = mermaidBlocks(readFileSync(join(root, 'docs/architecture.md'), 'utf8'))
  if (blocks.length !== DIAGRAMS.length) {
    console.error(`✘ docs/architecture.md 里有 ${String(blocks.length)} 个 mermaid 块，期望 ${String(DIAGRAMS.length)} 个`)
    process.exitCode = 1
    return
  }

  const outDir = join(root, 'docs/diagrams')
  const workDir = join(root, '.tmp-diagrams')
  mkdirSync(outDir, { recursive: true })
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })

  const edge = edgePath()
  for (const [index, plan] of DIAGRAMS.entries()) {
    const htmlPath = join(workDir, `${plan.name}.html`)
    const pngPath = join(outDir, `${plan.name}.png`)
    writeFileSync(htmlPath, pageOf(blocks[index] ?? '', mermaidJs), 'utf8')
    execFileSync(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${String(plan.width)},${String(plan.height)}`,
        '--virtual-time-budget=15000',
        `--screenshot=${pngPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore', timeout: 120_000 },
    )
    if (!existsSync(pngPath)) throw new Error(`渲染失败：${pngPath} 没有生成`)
    console.log(`✔ ${plan.title} → docs/diagrams/${plan.name}.png`)
  }
}

main()
