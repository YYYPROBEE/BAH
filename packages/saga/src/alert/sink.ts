/**
 * 告警出口的**窄接缝**（SA-12 批 5 使用；真实告警总线属 SA-13 批 6）。
 *
 * 为什么只放类型与 no-op：janitor / recon 需要 P0/P1 出口，但 SA-13 §3.4
 * 的进程内 bus 与 SLO 八指标属批 6。批 5 把出口收敛为一个两参回调，
 * 由装配位注入；测试注入记录器即可断言，生产在批 6 换成真实 sink。
 *
 * 本文件**不是** ServiceKey，不占用 SA-00 §4.5 的冻结面。
 */

/** 告警级别：P0 = 立即升级；P1 = 常规告警。 */
export type AlertLevel = 'P0' | 'P1'

/** 告警汇：只负责收下 (level, message)，邮件/webhook 由消费端决定。 */
export type AlertSink = (level: AlertLevel, message: string) => void

/** 未注入时的默认出口：显式空实现（批 6 装配真实总线后不再使用）。 */
export const noopAlertSink: AlertSink = () => {}
