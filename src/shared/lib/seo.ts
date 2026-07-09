import { getTranslations, setRequestLocale } from 'next-intl/server';

import { envConfigs } from '@/config';
import { defaultLocale, locales } from '@/config/locale';

const DEFAULT_PREVIEW_IMAGE = '/og.png';

// get metadata for page component
export function getMetadata(
  options: {
    title?: string;
    description?: string;
    keywords?: string;
    metadataKey?: string;
    canonicalUrl?: string; // relative path or full url
    imageUrl?: string;
    appName?: string;
    noIndex?: boolean;
  } = {}
) {
  return async function generateMetadata({
    params,
  }: {
    params: Promise<{ locale: string }>;
  }) {
    const { locale } = await params;
    setRequestLocale(locale);

    // passed metadata
    const passedMetadata = {
      title: options.title,
      description: options.description,
      keywords: options.keywords,
    };

    // default metadata
    const defaultMetadata = await getTranslatedMetadata(
      defaultMetadataKey,
      locale
    );

    // translated metadata
    let translatedMetadata: any = {};
    if (options.metadataKey) {
      translatedMetadata = await getTranslatedMetadata(
        options.metadataKey,
        locale
      );
    }

    // canonical url
    const canonicalUrl = await getCanonicalUrl(
      options.canonicalUrl || '',
      locale || ''
    );

    const title =
      passedMetadata.title || translatedMetadata.title || defaultMetadata.title;
    const description =
      passedMetadata.description ||
      translatedMetadata.description ||
      defaultMetadata.description;

    // image url
    // 项目自有的分享卡片图。app_preview_image 默认留空（brand-assets 守卫要求
    // 默认配置不指向占位品牌图），但完全不出 og:image 会让所有社媒/IM 分享
    // 都没有配图。注意：文件约定 opengraph-image 在这里不生效——
    // [locale]/layout.tsx 的 generateMetadata 定义了 openGraph，会整体覆盖它。
    let imageUrl =
      options.imageUrl || envConfigs.app_preview_image || DEFAULT_PREVIEW_IMAGE;
    if (imageUrl) {
      imageUrl = imageUrl.startsWith('http')
        ? imageUrl
        : `${envConfigs.app_url}${imageUrl}`;
    }

    // app name
    let appName = options.appName;
    if (!appName) {
      appName = envConfigs.app_name || '';
    }

    return {
      title:
        passedMetadata.title ||
        translatedMetadata.title ||
        defaultMetadata.title,
      description:
        passedMetadata.description ||
        translatedMetadata.description ||
        defaultMetadata.description,
      keywords:
        passedMetadata.keywords ||
        translatedMetadata.keywords ||
        defaultMetadata.keywords,
      alternates: {
        canonical: canonicalUrl,
        // 每个页面声明自己的多语言版本。原先在 root layout 手写 <link
        // rel="alternate">，对所有页面都指向首页——错误的 hreflang 比没有更糟。
        languages: await getAlternateLanguages(options.canonicalUrl || ''),
      },

      openGraph: {
        type: 'website',
        locale: locale,
        url: canonicalUrl,
        title,
        description,
        siteName: appName,
        ...(imageUrl ? { images: [imageUrl] } : {}),
      },

      twitter: {
        card: imageUrl ? 'summary_large_image' : 'summary',
        title,
        description,
        ...(imageUrl ? { images: [imageUrl] } : {}),
        site: envConfigs.app_url,
      },

      robots: {
        index: options.noIndex ? false : true,
        follow: options.noIndex ? false : true,
      },
    };
  };
}

const defaultMetadataKey = 'common.metadata';

async function getTranslatedMetadata(metadataKey: string, locale: string) {
  setRequestLocale(locale);
  const t = await getTranslations(metadataKey);

  return {
    title: t.has('title') ? t('title') : '',
    description: t.has('description') ? t('description') : '',
    keywords: t.has('keywords') ? t('keywords') : '',
  };
}

async function getCanonicalUrl(canonicalUrl: string, locale: string) {
  if (!canonicalUrl) {
    canonicalUrl = '/';
  }

  if (canonicalUrl.startsWith('http')) {
    // full url
    canonicalUrl = canonicalUrl;
  } else {
    // relative path
    if (!canonicalUrl.startsWith('/')) {
      canonicalUrl = `/${canonicalUrl}`;
    }

    canonicalUrl = `${envConfigs.app_url}${
      !locale || locale === defaultLocale ? '' : `/${locale}`
    }${canonicalUrl}`;

    if (locale !== defaultLocale && canonicalUrl.endsWith('/')) {
      canonicalUrl = canonicalUrl.slice(0, -1);
    }
  }

  return canonicalUrl;
}

async function getAlternateLanguages(path: string) {
  const languages: Record<string, string> = {};

  for (const locale of locales) {
    languages[locale] = await getCanonicalUrl(path, locale);
  }

  return languages;
}
