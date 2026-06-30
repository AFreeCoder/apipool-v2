import { Link } from '@/core/i18n/navigation';
import { Badge } from '@/shared/components/ui/badge';
import {
  SidebarHeader as SidebarHeaderComponent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/shared/components/ui/sidebar';
import { SidebarHeader as SidebarHeaderType } from '@/shared/types/blocks/dashboard';

export function SidebarHeader({ header }: { header: SidebarHeaderType }) {
  const { open } = useSidebar();
  return (
    <SidebarHeaderComponent className="mb-0">
      <SidebarMenu>
        <SidebarMenuItem className="flex items-center justify-between">
          {(open || !header.show_trigger) && (
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              {header.brand && (
                <Link
                  href={header.brand.url || ''}
                  className="flex min-w-0 items-center gap-2"
                >
                  {header.brand.logo?.src && (
                    <img
                      src={header.brand.logo.src}
                      alt={header.brand.logo.alt || ''}
                      className="h-auto w-8 shrink-0 rounded-md"
                    />
                  )}
                  <div className="flex min-w-0 items-center gap-1 text-base font-semibold">
                    <span className="truncate">{header.brand.title}</span>
                    {header.version && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 px-1 py-0 text-[10px]"
                      >
                        v{header.version}
                      </Badge>
                    )}
                  </div>
                </Link>
              )}
            </SidebarMenuButton>
          )}
          <div className="flex-1"></div>
          {header.show_trigger && <SidebarTrigger />}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeaderComponent>
  );
}
