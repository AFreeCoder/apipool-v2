'use client';

import { ComponentProps, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/utils';

/**
 * Password field with a neutral show/hide toggle. Stays within the
 * single-accent palette (icon uses muted-foreground/foreground only).
 */
export function PasswordInput({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={show ? 'text' : 'password'}
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((value) => !value)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex items-center px-3 transition-colors"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
