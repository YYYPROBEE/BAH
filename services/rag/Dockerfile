# BAH 知识平面 sidecar（D3）
#
# 构建：docker build -t bah-rag:local services/rag
# 运行（必须给 token，sidecar 无 token 直接拒启）：
#   docker run --rm -p 127.0.0.1:7801:7801 \
#     -e BAH_KNOWLEDGE_TOKEN=<与host相同的token> \
#     -v "$PWD/services/rag/data:/app/data:ro" \
#     -v "$PWD/services/rag/models:/app/models:ro" \
#     bah-rag:local
#
# 边界：
# - **不打模型**：`fastembed` 的模型目录（约 182MB）用只读绑定挂进来。
#   镜像里没有模型时启动会失败（fail-loud），不要为了"能起"塞空目录。
# - **不关认证**：容器里同样受 `banking_rag/auth.py` 的 fail-loud 约束。
# - 单进程 uvicorn（演示用），不是多 worker 生产部署。

FROM python:3.11-slim

# sqlite-vec / fastembed 的轮子在 slim 上需要 libgomp（onnxruntime 依赖）
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml requirements.txt ./
COPY src ./src

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -e .

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    HOME=/app

# 非 root：容器里不需要写仓库；运行期只读 data/models
RUN useradd --create-home --uid 10001 bah \
    && chown -R bah:bah /app
USER bah

EXPOSE 7801

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7801/healthz').status==200 else 1)"

# 监听 0.0.0.0：容器内绑回环时端口映射不到
CMD ["python", "-m", "uvicorn", "banking_rag.main:app", "--host", "0.0.0.0", "--port", "7801"]
