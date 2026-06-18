import moment from 'moment';
import { useLocale } from 'next-intl';

export function Time({
  value,
  placeholder,
  metadata,
  className,
}: {
  value: string | Date;
  placeholder?: string;
  metadata?: Record<string, any>;
  className?: string;
}) {
  if (!value) {
    if (placeholder) {
      return <div className={className}>{placeholder}</div>;
    }

    return null;
  }

  let locale = useLocale();
  if (locale === 'zh-CN' || locale === 'zh') {
    locale = 'zh-cn';
  } else if (locale === 'zh-TW') {
    locale = 'zh-tw';
  }

  return (
    <div className={className}>
      {metadata?.format
        ? moment(value).locale(locale).format(metadata?.format)
        : moment(value).locale(locale).fromNow()}
    </div>
  );
}
