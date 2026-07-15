'use client';

import type { ReactNode } from 'react';

import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';

export async function apiRequest<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as {
    code: number;
    message?: string;
    data?: T;
  };
  if (payload.code !== 0) throw new Error(payload.message || 'Request failed');
  return payload.data as T;
}

export function Panel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="grid grid-cols-[1fr_auto] gap-3">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="bg-muted text-muted-foreground rounded-md border px-3 py-2 text-sm">
      {message}
    </div>
  );
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function RecordTable({
  rows,
  columns,
  emptyLabel,
  actions,
}: {
  rows: Array<Record<string, unknown>>;
  columns: Array<{ key: string; label: string }>;
  emptyLabel: string;
  actions?: (row: Record<string, unknown>) => ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.key}>{column.label}</TableHead>
          ))}
          {actions && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length + (actions ? 1 : 0)}
              className="text-muted-foreground py-8 text-center"
            >
              {emptyLabel}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, index) => (
            <TableRow key={String(row.id ?? index)}>
              {columns.map((column) => (
                <TableCell key={column.key} className="max-w-64 truncate">
                  {displayValue(row[column.key])}
                </TableCell>
              ))}
              {actions && <TableCell>{actions(row)}</TableCell>}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export function RefreshButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  );
}
