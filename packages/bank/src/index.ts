/**
 * @bah/bank 包入口（插件线 07–08）。
 *
 * 逻辑模块子目录（施工单 00 §6）：
 * - `core/`：九实体、Provider seam、票据状态机、mock 核心；
 * - `forge/`：seeded 造数（demo / stress / adversarial）与风控预检；
 * - `tools/`：银行工具族（施工单 08：14 个 P0 工具 / presenter / 治理平面）；
 * - `context/`：实体槽位读取适配器（运行时上下文的数据层；host 装配成端口）；
 * - `verify/`：强验证渠道（挑战 / 锁定 / 可替换 Provider；施工单 09 §6）。
 */
export * from './core/index.ts'
export * from './detect/index.ts'
export * from './forge/index.ts'
export * from './tools/index.ts'
export * from './context/index.ts'
export * from './verify/index.ts'
