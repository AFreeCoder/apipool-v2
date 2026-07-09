import { Link } from '@/core/i18n/navigation';

export interface ModelFilterOption {
  slug: string;
  name: string;
  href: string;
  active: boolean;
}

export interface ModelFilterGroup {
  key: string;
  label: string;
  allHref: string;
  activeName: string | null;
  options: ModelFilterOption[];
}

/**
 * Stacked filter rows for /models: every dimension lists ALL of its options
 * as flat pills (docs/05 §6 — 全量清单平铺，不用下拉收纳). Filter state lives
 * in the URL, so each pill is a plain link and this stays a server component.
 */
export function ModelFilters({
  groups,
  allLabel,
  clearLabel,
  clearHref,
}: {
  groups: ModelFilterGroup[];
  allLabel: string;
  clearLabel: string;
  clearHref: string;
}) {
  const hasAnyActive = groups.some((group) => group.activeName !== null);

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground w-20 shrink-0 text-xs tracking-wide uppercase">
            {group.label}
          </span>
          <FilterLink active={group.activeName === null} href={group.allHref}>
            {allLabel}
          </FilterLink>
          {group.options.map((option) => (
            <FilterLink
              key={option.slug}
              active={option.active}
              href={option.href}
            >
              {option.name}
            </FilterLink>
          ))}
        </div>
      ))}
      {hasAnyActive && (
        <div className="pt-1">
          <Link
            href={clearHref}
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 transition-colors hover:underline"
          >
            {clearLabel}
          </Link>
        </div>
      )}
    </div>
  );
}

function FilterLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  const base =
    'focus-visible:ring-ring inline-flex min-h-8 items-center rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-0';

  return (
    <Link
      href={href}
      className={
        active
          ? `${base} bg-primary text-primary-foreground font-medium`
          : `${base} text-muted-foreground hover:text-foreground hover:bg-muted border`
      }
    >
      {children}
    </Link>
  );
}
