import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/** A report filter's dialog is non-modal: interacting elsewhere dismisses it. */
export function useReportPopoverDismiss(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  }, [open, setOpen]);

  return { containerRef, triggerRef };
}
