/** The Profile identity is a process boundary supplied by Hermes. */
export interface ProfileContext {
  id: string;
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function requireProfileContext(value = process.env.HERMES_PROFILE): ProfileContext {
  if (!value || !PROFILE_RE.test(value)) {
    throw new Error("HERMES_PROFILE is required and must be 1-64 ASCII letters, digits, '.', '_' or '-'");
  }
  return { id: value };
}

/**
 * 接受 ProfileContext 或裸 id 并归一为 ProfileContext；与 requireProfileContext
 * 同一口径校验。schedule/automation 服务的公共服务入口共用，避免各自维护副本。
 */
export function asProfileContext(value: ProfileContext | string): ProfileContext {
  return requireProfileContext(typeof value === "string" ? value : value.id);
}

/** 与 Profile 身份同口径的短 ID 规则（1–64 位 ASCII，字母/数字开头）。assistant 导入等按 ID 幂等的场景共用。 */
export function isWellFormedId(value: string): boolean {
  return PROFILE_RE.test(value);
}
