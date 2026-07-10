'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Textarea } from '@/shared/components/ui/textarea';

export type ResolveAdjustmentLabels = {
  trigger: string;
  title: string;
  description: string;
  changeIdLabel: string;
  noteLabel: string;
  notePlaceholder: string;
  confirmApplied: string;
  markVoid: string;
  cancel: string;
  noteRequired: string;
  failed: string;
};

/**
 * 未结清账本行的人工裁决入口。门户无法替管理员判断远端到底有没有入账
 * （New API 没有可查兑换状态的接口），所以这里强制要求写下核对依据。
 */
export function ResolveAdjustmentButton({
  ledgerId,
  newapiChangeId,
  labels,
  action,
}: {
  ledgerId: string;
  newapiChangeId: string | null;
  labels: ResolveAdjustmentLabels;
  action: (input: {
    ledgerId: string;
    resolution: 'confirm_applied' | 'mark_void';
    note: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(resolution: 'confirm_applied' | 'mark_void') {
    if (!note.trim()) {
      toast.error(labels.noteRequired);
      return;
    }
    startTransition(async () => {
      try {
        await action({ ledgerId, resolution, note });
        setOpen(false);
        setNote('');
        router.refresh();
      } catch {
        toast.error(labels.failed);
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        {labels.trigger}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            <DialogDescription>{labels.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="text-muted-foreground">
              {labels.changeIdLabel}:{' '}
              <span className="text-foreground font-mono text-xs">
                {newapiChangeId || '—'}
              </span>
            </div>
            <label className="grid gap-2">
              {labels.noteLabel}
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={labels.notePlaceholder}
                rows={3}
              />
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              {labels.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => submit('mark_void')}
            >
              {labels.markVoid}
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => submit('confirm_applied')}
            >
              {labels.confirmApplied}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
