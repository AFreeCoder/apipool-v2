import Image from 'next/image';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

import { i18n } from '@/core/docs/source';
import { envConfigs } from '@/config';

export function baseOptions(locale: string): BaseLayoutProps {
  const prefix = locale === 'en' ? '' : `/${locale}`;

  return {
    // 文档读者是最接近转化的人群。进了 /docs 之后主站 header 不再渲染，
    // 没有入口就只能靠正文内链回去。
    links: [
      { text: locale === 'zh' ? '模型与价格' : 'Models', url: `${prefix}/models` },
      { text: locale === 'zh' ? '控制台' : 'Console', url: `${prefix}/dashboard` },
    ],
    nav: {
      title: (
        <>
          {envConfigs.app_logo ? (
            <Image
              src={envConfigs.app_logo}
              alt={envConfigs.app_name}
              width={28}
              height={28}
              className=""
            />
          ) : null}
          <span className="text-primary text-lg font-bold">
            {envConfigs.app_name}
          </span>
        </>
      ),
      transparentMode: 'top',
    },
    i18n,
  };
}
