# BAH 银行智能体 · 单容器 Web 演示
#
# 构建：docker build -t bah:local .
# 运行：docker run --rm -p 7331:7331 bah:local   # 默认离线 router，不需要模型密钥
#       浏览器打开 http://127.0.0.1:7331
#
# 边界（与 docs/deploy.md 一致）：
# - 只含 Web 渠道（7331）；RAG sidecar（7801）不在本镜像内，知识工具会 fail-closed
#   为 knowledge-unavailable，转账主场景不受影响。
# - 源码直跑（tsx），不产出 dist；前端是原生 ES 模块，本来就不需要构建。
# - 仓库默认监听 127.0.0.1（只适合本机演示）；容器内改为 0.0.0.0，否则 -p 7331:7331
#   映射不到。这是镜像内唯一的配置差异，其余与 profiles/web/patch.yml 完全一致。

FROM node:22-bookworm-slim

# BAH_KNOWLEDGE_KEY 用 docs/deploy.md §3 指定的公开演示值；任何真实部署都必须用 -e 覆盖
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    BAH_KNOWLEDGE_KEY=demo-key-not-for-prod

RUN corepack enable && corepack prepare pnpm@10.34.7 --activate

WORKDIR /app

COPY . .

# --ignore-scripts：跳过根 prepare（`git config core.hooksPath`，容器内无 .git），
# 依赖树里没有原生模块，跳过安装脚本不影响运行。
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && sed -i 's/^    host: 127\.0\.0\.1$/    host: 0.0.0.0/' profiles/web/patch.yml \
    && mkdir -p sessions \
    && chown -R node:node /app

USER node

EXPOSE 7331

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7331/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "web"]
