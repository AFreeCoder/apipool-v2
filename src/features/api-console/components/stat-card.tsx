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
    <div className="rounded-lg border bg-background p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{label}</div>
        {icon}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {help && <div className="mt-2 text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
