import { envConfigs } from '@/config';
import {
  BrandLogo,
  LocaleSelector,
  ThemeToggler,
} from '@/shared/blocks/common';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 页头走文档流（而非 absolute 罩在视口上），这样语言建议条等
  // 流内横幅出现时页头会被自然下推，不会与横幅互相叠压。
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <BrandLogo
          brand={{
            title: envConfigs.app_name,
            logo: {
              src: envConfigs.app_logo,
              alt: envConfigs.app_name,
            },
            url: '/',
            target: '_self',
            className: '',
          }}
        />
        <div className="flex items-center gap-4">
          <ThemeToggler />
          <LocaleSelector type="button" />
        </div>
      </header>
      <div className="flex w-full flex-1 items-center justify-center px-4 pb-16">
        {children}
      </div>
    </div>
  );
}
