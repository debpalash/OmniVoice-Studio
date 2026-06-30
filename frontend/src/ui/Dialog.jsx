import React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import Button from './Button';
import './Dialog.css';

// Per-size max-width. The rest of the dialog surface (glass gradient,
// backdrop-filter, fixed centering, open/close keyframes) stays in Dialog.css
// because those rules can't be expressed as — or safely reduced to — utilities.
const DIALOG_MAX_W = {
  sm: 'max-w-[380px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[780px]',
  xl: 'max-w-[1080px]',
};

/**
 * Dialog — accessible modal backed by @radix-ui/react-dialog.
 *
 * Provides focus trapping, Escape-to-close, scroll lock, and
 * proper ARIA attributes out of the box.
 *
 * @param open        controlled visibility
 * @param onClose     called on backdrop click / ESC / close button
 * @param title       string | ReactNode in the header; omit for header-less dialog
 * @param footer      node rendered in the footer region (actions)
 * @param size        'sm' | 'md' | 'lg' | 'xl'
 * @param dismissable whether backdrop click / ESC closes (default true)
 */
export default function Dialog({
  open,
  onClose,
  title = null,
  footer = null,
  size = 'md',
  dismissable = true,
  children,
}) {
  const handleOpenChange = (nextOpen) => {
    if (!nextOpen && dismissable) onClose?.();
  };

  const handleEscapeKeyDown = (e) => {
    if (!dismissable) e.preventDefault();
  };

  const handlePointerDownOutside = (e) => {
    if (!dismissable) e.preventDefault();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={handleOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog-backdrop" />
        <RadixDialog.Content
          className={`ui-dialog ${DIALOG_MAX_W[size] || DIALOG_MAX_W.md}`}
          onEscapeKeyDown={handleEscapeKeyDown}
          onPointerDownOutside={handlePointerDownOutside}
          aria-describedby={undefined}
        >
          {(title || dismissable) && (
            <header className="flex shrink-0 items-center justify-between gap-[var(--space-4)] border-b border-border px-[var(--space-6)] py-[var(--space-5)]">
              {title && (
                <RadixDialog.Title className="m-0 font-serif text-[length:var(--text-lg)] font-bold tracking-[-0.01em] text-fg">
                  {title}
                </RadixDialog.Title>
              )}
              {dismissable && (
                <RadixDialog.Close asChild>
                  <Button variant="icon" iconSize="sm" aria-label="Close">
                    <X size={12} />
                  </Button>
                </RadixDialog.Close>
              )}
            </header>
          )}
          {!title && <RadixDialog.Title className="sr-only">Dialog</RadixDialog.Title>}
          <div className="min-h-0 overflow-y-auto p-[var(--space-6)]">{children}</div>
          {footer && (
            <footer className="flex shrink-0 items-center justify-end gap-[var(--space-3)] border-t border-border px-[var(--space-6)] py-[var(--space-4)]">
              {footer}
            </footer>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
