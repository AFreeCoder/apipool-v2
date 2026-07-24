const LOCALE_SEGMENTS = new Set(['en', 'zh']);

export const NOINDEX_PATH_PREFIXES = [
  '/admin',
  '/dashboard',
  '/settings',
  '/activity',
  '/api',
] as const;

export function normalizePathWithoutLocale(pathname: string): string {
  const pathOnly = pathname.split(/[?#]/)[0] || '/';
  const normalized = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length > 0 && LOCALE_SEGMENTS.has(segments[0])) {
    const pathWithoutLocale = segments.slice(1).join('/');
    return pathWithoutLocale ? `/${pathWithoutLocale}` : '/';
  }

  return normalized === '' ? '/' : normalized;
}

export function localizePathForLocale(
  pathname: string,
  locale: string
): string {
  const [, pathOnly = '/', suffix = ''] =
    pathname.match(/^([^?#]*)(.*)$/) ?? [];
  const normalizedPath = normalizePathWithoutLocale(pathOnly);

  if (!LOCALE_SEGMENTS.has(locale)) {
    return `${normalizedPath}${suffix}`;
  }

  if (locale === 'en') {
    return `${normalizedPath}${suffix}`;
  }

  const localizedPath =
    normalizedPath === '/' ? `/${locale}` : `/${locale}${normalizedPath}`;

  return `${localizedPath}${suffix}`;
}

export function shouldNoIndexPath(pathname: string): boolean {
  const normalized = normalizePathWithoutLocale(pathname);

  return NOINDEX_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

export function getRobotsDisallowRules(): string[] {
  return [
    '/*?*q=',
    '/privacy-policy',
    '/terms-of-service',
    ...NOINDEX_PATH_PREFIXES.map((prefix) => `${prefix}/*`),
  ];
}
