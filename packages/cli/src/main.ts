/**
 * `@bah/cli` 可执行入口（M0 占位）。
 *
 * 根 `package.json` 的 `bah` 脚本指向本文件（施工单 01 §1），
 * 所以它必须真实存在——但到目前为止不实现任何运行逻辑：
 * profile 解析、bundle reconcile、插件安装在施工单 06 落地；
 * `--profile headless --dump-config` 是阶段 6 的人工抽查点。
 *
 * 进程级冒烟见同目录 `main.smoke.test.ts`（验 tsx 运行 + workspace 解析 + exit code）。
 */

console.log('bah: 底座骨架 —— CLI 在施工单 06 接入 profile 组合后可用（当前无运行逻辑）')
