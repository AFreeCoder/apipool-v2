'use client';

import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { Link, usePathname } from '@/core/i18n/navigation';
import { SignUser } from '@/shared/blocks/sign/sign-user';
import { Button } from '@/shared/components/ui/button';
import { useAppContext } from '@/shared/contexts/app';
import { UserNav } from '@/shared/types/blocks/common';

/**
 * Header auth cluster: keep the navigation quiet and follow docs/05-design-system.md.
 *
 * - Signed out:  [sign in (ghost)] [get started (outline)]
 * - Signed in:   [console (outline)] [avatar] — console hidden while already
 *   inside /dashboard so the header never advertises the page you are on.
 *
 * Theme + language live in the avatar dropdown (show_preferences) and in the
 * footer for signed-out visitors, keeping the header itself quiet.
 */
export function HeaderAuthCluster({
  consoleLabel,
  getStartedLabel,
  userNav,
}: {
  consoleLabel: string;
  getStartedLabel: string;
  userNav: UserNav;
}) {
  const { user, isCheckSign } = useAppContext();
  const pathname = usePathname();
  const inConsole = pathname.startsWith('/dashboard');

  // isCheckSign 的初始值依赖仅存在于服务端的 envConfigs.auth_secret，
  // 两端首次渲染会分叉；挂载后再渲染登出态 CTA，避免 hydration mismatch。
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // 主 CTA（进入控制台 / 开始使用）用品牌绿实心按钮，贴合设计稿；
  // 仍保持"头部至多两个控件、登录用 ghost、在 /dashboard 内隐藏控制台入口"。
  const cta = user ? (
    inConsole ? null : (
      <Button asChild size="sm">
        <Link href="/dashboard">
          {consoleLabel}
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    )
  ) : (
    <Button asChild size="sm">
      <Link href="/sign-up">
        {getStartedLabel}
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );

  return (
    <div className="flex items-center gap-2">
      {user && cta}
      <SignUser
        signButtonSize="sm"
        signButtonVariant="ghost"
        userNav={userNav}
      />
      {mounted && !user && !isCheckSign && cta}
    </div>
  );
}
