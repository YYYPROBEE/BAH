# bank-tier-demo

演示用候选 bundle，**不进生产路径**（registry 标记 `demo: true`）。

## 1.0.0

- 从 `bank-tier/1.0.0` 派生；
- 新增 `TR-004-single-large`：单笔 ≥ 500000 分（5000 元）直接升红；
- 用途：证明判决真的来自外置规则文件，并作为灰度/影子演练的候选版本。
