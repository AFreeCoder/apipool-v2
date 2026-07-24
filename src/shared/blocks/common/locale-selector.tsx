'use client';

import { useEffect, useState } from 'react';
import { Check, Globe, Languages } from 'lucide-react';

import { localeNames } from '@/config/locale';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { cn } from '@/shared/lib/utils';

import { useLocaleSwitcher } from './use-locale-switcher';

export function LocaleSelector({
  type = 'icon',
  className,
  label,
}: {
  type?: 'icon' | 'button';
  className?: string;
  label?: string;
}) {
  const { currentLocale, switchLocale } = useLocaleSwitcher();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Return a placeholder during SSR to avoid hydration mismatch
  if (!mounted) {
    return (
      <Button
        variant={type === 'icon' ? 'ghost' : 'outline'}
        size={type === 'icon' ? 'icon' : 'sm'}
        className={cn(
          type === 'icon' ? 'h-auto w-auto p-0' : 'hover:bg-primary/10',
          className
        )}
        aria-label={label}
        disabled
      >
        {type === 'icon' ? (
          <Languages size={18} />
        ) : (
          <>
            <Globe size={16} />
            {localeNames[currentLocale]}
          </>
        )}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {type === 'icon' ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-auto w-auto p-0', className)}
            aria-label={label}
          >
            <Languages size={18} />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className={cn('hover:bg-primary/10', className)}
            aria-label={label}
          >
            <Globe size={16} />
            {localeNames[currentLocale]}
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {Object.keys(localeNames).map((locale) => (
          <DropdownMenuItem key={locale} onClick={() => switchLocale(locale)}>
            <span>{localeNames[locale]}</span>
            {locale === currentLocale && (
              <Check size={16} className="text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
