import React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import Button from './Button';
import './Dialog.css';

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
          className={`ui-dialog ui-dialog--${size}`}
          onEscapeKeyDown={handleEscapeKeyDown}
          onPointerDownOutside={handlePointerDownOutside}
          aria-describedby={undefined}
        >
          {(title || dismissable) && (
            <header className="ui-dialog__header">
              {title && (
                <RadixDialog.Title className="ui-dialog__title">
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
          <div className="ui-dialog__body">{children}</div>
          {footer && <footer className="ui-dialog__footer">{footer}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
