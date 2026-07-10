'use client';

import { ReactNode } from 'react';
import { CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CopyToClipboard } from 'react-copy-to-clipboard';
import { toast } from 'sonner';

export function Copy({
  value,
  placeholder,
  metadata,
  className,
  children,
}: {
  value: string;
  placeholder?: string;
  metadata?: Record<string, any>;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations('admin.common');

  return (
    <CopyToClipboard
      text={value}
      onCopy={() => toast.success(metadata?.message ?? t('table.copied'))}
    >
      <div className={`flex cursor-pointer items-center gap-2 ${className}`}>
        {children}
        <CopyIcon className="h-3 w-3" />
      </div>
    </CopyToClipboard>
  );
}
