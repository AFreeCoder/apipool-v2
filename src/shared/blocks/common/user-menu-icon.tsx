import {
  BarChart3,
  KeyRound,
  ReceiptText,
  type LucideIcon,
} from 'lucide-react';

import { SmartIcon } from './smart-icon';

// 默认用户菜单是登录后的高频入口。把这些已知图标随组件一起加载，避免首次
// 打开 Radix portal 时才触发 SmartIcon 的异步模块加载，造成文字先出现、图标补帧。
const eagerUserMenuIcons: Record<string, LucideIcon> = {
  BarChart3,
  KeyRound,
  ReceiptText,
};

export function UserMenuIcon({
  name,
  className = 'h-4 w-4',
}: {
  name: string;
  className?: string;
}) {
  const Icon = eagerUserMenuIcons[name];

  if (Icon) {
    return <Icon aria-hidden="true" className={className} />;
  }

  return <SmartIcon name={name} className={className} aria-hidden="true" />;
}
