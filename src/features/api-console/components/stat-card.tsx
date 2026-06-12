import { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  help,
  icon,
}: {
  label: string;
  value: ReactNode;
  help?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="bg-background rounded-xl border p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-muted-foreground text-xs tracking-wide uppercase">
          {label}
        </div>
        {icon}
      </div>
      <div className="font-mono text-2xl font-semibold tracking-tight">
        {value}
      </div>
      {help && <div className="text-muted-foreground mt-2 text-xs">{help}</div>}
    </div>
  );
}
