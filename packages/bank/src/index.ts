/**
 * @bah/bank 包入口（插件线 07：仿真银行核心）。
 *
 * 逻辑模块子目录（施工单 00 §6）：
 * - `core/`：九实体、Provider seam、票据状态机、mock 核心；
 * - `forge/`：seeded 造数（demo / stress / adversarial）与风控预检；
 * - `tools/`：银行工具族（施工单 08，尚未实装）；
 * - `verify/`：工具目录校验（施工单 08，尚未实装）。
 */
export * from './core/index.ts'
export * from './forge/index.ts'
