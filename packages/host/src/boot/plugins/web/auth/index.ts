/**
 * `web/auth/*` 的入口（re-export）。
 *
 * 纪律：**只有 barrel 被外部 import**（`web.ts` / `dispatch.ts` / `handlers/*`），
 * 这样"认证面"对外只有一个门，`verify-tenant-scope` 之类的判据也只需要认一个路径。
 */

export {
  AUTH_MODES,
  DEFAULT_AUTH,
  resolveAuthSettings,
  type AuthMode,
  type AuthSettings,
} from './config.ts'
export { DUMMY_HASH, hashPassword, parseEncodedHash, verifyPassword } from './password.ts'
export { loadDirectory, type DirectoryUser, type LoadDirectoryOptions, type UserDirectory } from './directory.ts'
export {
  DEFAULT_SESSION_CAPACITY,
  createSessionStore,
  type AuthSession,
  type SessionStore,
  type SessionStoreOptions,
} from './session-store.ts'
export { createThrottle, type Throttle, type ThrottleSettings } from './throttle.ts'
export {
  createAuthRuntime,
  type AuthAuditEntry,
  type AuthRuntime,
  type AuthRuntimeOptions,
  type LoginInput,
  type LoginResult,
  type RequestIdentity,
} from './identity.ts'
export {
  STATIC_OPERATOR_ROLES,
  STATIC_OPERATOR_USER,
  STATIC_WEB_ROLES,
  STATIC_WEB_USER,
  createStaticIdentifier,
  type StaticIdentifier,
  type StaticIdentifierOptions,
} from './static.ts'
export { clearSessionCookieHeader, sessionCookieHeader } from './cookies.ts'
