export const SMOKE_PORTAL_EMAIL = 'smoke.portal@apipool.local';
export const SMOKE_OPERATOR_EMAIL = 'smoke.operator@apipool.local';

function normalizeEmail(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function assertSmokeIdentity({
  actualEmail,
  configuredEmail,
  expectedEmail,
  role,
}: {
  actualEmail: string | null | undefined;
  configuredEmail: string | null | undefined;
  expectedEmail: string;
  role: 'portal' | 'operator';
}) {
  if (normalizeEmail(configuredEmail) !== expectedEmail) {
    throw new Error(
      `APIPOOL_SMOKE_${role.toUpperCase()}_EMAIL 必须固定为 ${expectedEmail}`
    );
  }

  if (normalizeEmail(actualEmail) !== expectedEmail) {
    throw new Error(`${role} smoke user id 未绑定到固定邮箱 ${expectedEmail}`);
  }
}
