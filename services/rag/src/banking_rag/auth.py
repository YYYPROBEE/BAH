"""认证：Bearer token → AuthContext（请求体不能自证身份）。

两种模式（construct 时二选一，都没有则 fail-loud）：

1. 生产/测试：HMAC-SHA256 签名 token，payload claims 包含
   `sub/role/audience/channel/region/productId/sessionId/exp`；
2. 演示：`BAH_RAG_TOKEN` 静态 token，claims 从 `BAH_RAG_DEMO_*` 环境变量读取。

token 结构：`v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)>`。
签名输入是 `v1.<payload>`，与 JWT 一样只签 body，不签 header。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .contract import Principal

TOKEN_ENV = "BAH_RAG_TOKEN"
LEGACY_TOKEN_ENV = "BAH_KNOWLEDGE_TOKEN"
SECRET_ENV = "BAH_RAG_TOKEN_SECRET"
FULL_SCOPE_ROLES_ENV = "BAH_RAG_FULL_SCOPE_ROLES"
DEFAULT_FULL_SCOPE_ROLES = frozenset({"admin"})
TOKEN_VERSION = "v1"


class AuthError(RuntimeError):
    """结构化鉴权失败；main 统一映射为 401。"""

    def __init__(self, code: str = "UNAUTHORIZED", message: str = "鉴权失败") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AuthClaims:
    sub: str
    role: str
    audience: str
    channel: str
    region: str
    product_id: str | None
    session_id: str
    exp: int


@dataclass(frozen=True)
class AuthContext:
    """认证后身份；principal/session/now 全部由服务端派生。"""

    claims: AuthClaims
    principal: Principal

    @property
    def subject(self) -> str:
        return self.claims.sub

    @property
    def session_id(self) -> str:
        return self.claims.session_id


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + padding)
    except (ValueError, TypeError) as exc:
        raise AuthError("TOKEN_MALFORMED", "token 编码不合法") from exc


def _required_string(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AuthError("TOKEN_CLAIMS_INVALID", f"token 缺少声明 {key}")
    return value.strip()


def _claims_from_payload(payload: Mapping[str, Any]) -> AuthClaims:
    product = payload.get("productId")
    if product is not None and not isinstance(product, str):
        raise AuthError("TOKEN_CLAIMS_INVALID", "productId 必须是字符串或 null")
    exp = payload.get("exp")
    if not isinstance(exp, int) or isinstance(exp, bool):
        raise AuthError("TOKEN_CLAIMS_INVALID", "exp 必须是整数")
    return AuthClaims(
        sub=_required_string(payload, "sub"),
        role=_required_string(payload, "role"),
        audience=_required_string(payload, "audience"),
        channel=_required_string(payload, "channel"),
        region=_required_string(payload, "region"),
        product_id=product,
        session_id=_required_string(payload, "sessionId"),
        exp=exp,
    )


def issue_token(
    claims: Mapping[str, Any],
    secret: str,
    *,
    now: float | None = None,
    ttl_seconds: int = 3600,
) -> str:
    """签发票据（测试与本地联调用；生产由身份服务签发）。"""

    if not secret:
        raise ValueError("签发 token 需要 secret")
    payload: dict[str, Any] = dict(claims)
    payload.setdefault("exp", int((now if now is not None else time.time()) + ttl_seconds))
    body = _b64encode(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    )
    signing_input = f"{TOKEN_VERSION}.{body}".encode("ascii")
    signature = _b64encode(hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest())
    return f"{TOKEN_VERSION}.{body}.{signature}"


def _bearer(authorization: str | None) -> str:
    if authorization is None:
        raise AuthError("UNAUTHORIZED", "缺少 Authorization")
    scheme, separator, token = authorization.strip().partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        raise AuthError("UNAUTHORIZED", "只接受 Bearer token")
    return token.strip()


@dataclass(frozen=True)
class DemoClaims:
    sub: str = "demo"
    role: str = "retail"
    audience: str = "standard"
    channel: str = "headless"
    region: str = "CN-SH"
    product_id: str | None = None
    session_id: str = "demo-session"
    exp: int = 0

    @classmethod
    def from_env(cls) -> DemoClaims:
        product = os.environ.get("BAH_RAG_DEMO_PRODUCT") or None
        return cls(
            sub=os.environ.get("BAH_RAG_DEMO_SUB", cls.sub),
            role=os.environ.get("BAH_RAG_DEMO_ROLE", cls.role),
            audience=os.environ.get("BAH_RAG_DEMO_AUDIENCE", cls.audience),
            channel=os.environ.get("BAH_RAG_DEMO_CHANNEL", cls.channel),
            region=os.environ.get("BAH_RAG_DEMO_REGION", cls.region),
            product_id=product,
            session_id=os.environ.get("BAH_RAG_DEMO_SESSION", cls.session_id),
        )

    def as_claims(self) -> AuthClaims:
        return AuthClaims(
            sub=self.sub,
            role=self.role,
            audience=self.audience,
            channel=self.channel,
            region=self.region,
            product_id=self.product_id,
            session_id=self.session_id,
            exp=self.exp,
        )


class Authenticator:
    """把 Authorization 头校验成 AuthContext；构造时缺配置直接抛错。"""

    def __init__(
        self,
        *,
        secret: str | None = None,
        demo_token: str | None = None,
        demo_claims: DemoClaims | None = None,
        demo_full_scope: bool = True,
        full_scope_roles: frozenset[str] = DEFAULT_FULL_SCOPE_ROLES,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not secret and not demo_token:
            raise RuntimeError(
                f"认证未配置：请设置 {SECRET_ENV}（签名模式）或 {TOKEN_ENV}（演示模式）"
            )
        self.secret = secret
        self.demo_token = demo_token
        self.demo_claims = demo_claims or DemoClaims()
        self.demo_full_scope = demo_full_scope
        self.full_scope_roles = full_scope_roles
        self.clock = clock

    @classmethod
    def from_env(cls, *, clock: Callable[[], float] = time.time) -> Authenticator:
        roles = frozenset(
            part.strip()
            for part in os.environ.get(FULL_SCOPE_ROLES_ENV, "").split(",")
            if part.strip()
        )
        secret = os.environ.get(SECRET_ENV) or None
        demo_token = os.environ.get(TOKEN_ENV) or os.environ.get(LEGACY_TOKEN_ENV) or None
        return cls(
            secret=secret,
            demo_token=demo_token,
            demo_claims=DemoClaims.from_env(),
            full_scope_roles=roles or DEFAULT_FULL_SCOPE_ROLES,
            clock=clock,
        )

    def authenticate(self, authorization: str | None) -> AuthContext:
        presented = _bearer(authorization)
        if self.secret:
            claims = self._verify_signed(presented)
            full_scope = claims.product_id is None and claims.role in self.full_scope_roles
        else:
            assert self.demo_token is not None  # 构造函数已保证
            if not hmac.compare_digest(presented, self.demo_token):
                raise AuthError("UNAUTHORIZED", "token 无效")
            claims = self.demo_claims.as_claims()
            full_scope = claims.product_id is None and self.demo_full_scope
        now = datetime.fromtimestamp(self.clock(), tz=timezone.utc)
        return AuthContext(
            claims=claims,
            principal=Principal(
                role=claims.role,
                audience=claims.audience,
                channel=claims.channel,
                region=claims.region,
                product_id=claims.product_id,
                full_scope=full_scope,
                now=now,
            ),
        )

    def _verify_signed(self, token: str) -> AuthClaims:
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != TOKEN_VERSION:
            raise AuthError("TOKEN_MALFORMED", "token 结构不合法")
        _, body, signature = parts
        expected = _b64encode(
            hmac.new(
                (self.secret or "").encode("utf-8"),
                f"{TOKEN_VERSION}.{body}".encode("ascii"),
                hashlib.sha256,
            ).digest()
        )
        if not hmac.compare_digest(signature, expected):
            raise AuthError("TOKEN_SIGNATURE_INVALID", "token 签名无效")
        try:
            payload = json.loads(_b64decode(body))
        except (ValueError, UnicodeDecodeError) as exc:
            raise AuthError("TOKEN_MALFORMED", "token payload 不是 JSON") from exc
        if not isinstance(payload, dict):
            raise AuthError("TOKEN_MALFORMED", "token payload 必须是对象")
        claims = _claims_from_payload(payload)
        if claims.exp <= int(self.clock()):
            raise AuthError("TOKEN_EXPIRED", "token 已过期")
        return claims
