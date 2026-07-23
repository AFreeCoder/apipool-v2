import { type ElementType } from 'react';
import {
  Activity,
  BadgeCheck,
  BarChart3,
  BookOpenText,
  Bot,
  Boxes,
  CreditCard,
  Eye,
  Gauge,
  Github,
  HelpCircle,
  History,
  Home,
  KeyRound,
  Layers,
  Layers3,
  ListChecks,
  Mail,
  Menu,
  Plus,
  ReceiptText,
  Settings,
  Settings2,
  Shapes,
  ShieldCheck,
  Store,
  Tags,
  Trash2,
  User,
  Users,
  Wallet,
  Waypoints,
} from 'lucide-react';
import {
  RiChat2Line,
  RiDiscordFill,
  RiEditLine,
  RiKeyLine,
  RiTaskLine,
  RiTwitterXFill,
} from 'react-icons/ri';

// 下拉、折叠和移动侧栏的内容通常只在首次打开时挂载。这里同步导入所有
// 当前交互菜单图标，保证文字和图标同帧绘制，不触发 SmartIcon 的异步补帧。
const menuIcons: Record<string, ElementType> = {
  Activity,
  BadgeCheck,
  BarChart3,
  BookOpenText,
  Bot,
  Boxes,
  CreditCard,
  Eye,
  Gauge,
  Github,
  History,
  Home,
  KeyRound,
  Layers,
  Layers3,
  ListChecks,
  Mail,
  Menu,
  Plus,
  ReceiptText,
  RiChat2Line,
  RiDiscordFill,
  RiEditLine,
  RiKeyLine,
  RiTaskLine,
  RiTwitterXFill,
  Settings,
  Settings2,
  Shapes,
  ShieldCheck,
  Store,
  Tags,
  Trash2,
  User,
  Users,
  Wallet,
  Waypoints,
};

export function MenuIcon({
  name,
  size = 24,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  // 交互菜单不允许回退到异步图标。新图标若尚未登记，先同步显示兜底图标，
  // 并由回归测试提示补充注册表。
  const Icon = menuIcons[name] ?? HelpCircle;

  return <Icon aria-hidden="true" className={className} size={size} />;
}
