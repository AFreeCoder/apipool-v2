// drizzle-orm 会把底层 SQLite 错误包一层：`error.message` 变成
// "Failed query: insert into ..."，真正的 "UNIQUE constraint failed: <table>.<col>"
// 落在 `error.cause`（甚至 cause.cause）里。只看 message 的旧写法永远匹配不到，
// 于是唯一索引冲突在 dev 露出原始 SQLite 错误、在 prod 被 Next.js 脱敏成通用英文。

export function collectErrorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 6) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') messages.push(message);
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }

  return messages.join(' | ');
}

export function isUniqueConstraintError(error: unknown): boolean {
  return /UNIQUE constraint/i.test(collectErrorMessages(error));
}
