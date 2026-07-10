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

/**
 * A destructive server action behind an explicit confirmation dialog.
 * Refreshes the current route after the action so the page reflects the
 * new state without a manual reload.
 */
export function ConfirmActionButton({
  action,
  label,
  title,
  description,
  confirmLabel,
  cancelLabel,
  errorMessage,
  variant = 'destructive',
}: {
  action: () => Promise<void>;
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  errorMessage: string;
  variant?: 'destructive' | 'default' | 'outline';
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={variant}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await action();
                    setOpen(false);
                    router.refresh();
                  } catch {
                    toast.error(errorMessage);
                  }
                })
              }
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
