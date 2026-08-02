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
