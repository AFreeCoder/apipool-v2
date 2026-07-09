import { MetadataRoute } from 'next';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { defaultLocale, locales } from '@/config/locale';

// 动态生成：原先是手工维护的 public/sitemap.xml，lastmod 全部停在 2026-05-24，
// 且域名写的是 apipool.dev 而非门户实际域名。静态文件还会遮蔽这个路由。
//
// 不收录法律页：它们在 robots.ts 的 disallow 列表里，两处必须一致。
const INDEXABLE_PATHS = ['/', '/models', '/docs'] as const;

function localizedUrl(path: string, locale: string) {
  const base = APIPOOL_CONFIG.siteUrl.replace(/\/$/, '');
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  // 默认语言的首页是 `/`，带前缀语言的首页是 `/zh`（不再补尾斜杠）
  const suffix = path === '/' ? (prefix ? '' : '/') : path;
  return `${base}${prefix}${suffix}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return INDEXABLE_PATHS.flatMap((path) =>
    locales.map((locale) => ({
      url: localizedUrl(path, locale),
      lastModified,
      alternates: {
        languages: Object.fromEntries(
          locales.map((alt) => [alt, localizedUrl(path, alt)])
        ),
      },
    }))
  );
}
