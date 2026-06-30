import React, { forwardRef, useId } from 'react';
import * as RadixSlider from '@radix-ui/react-slider';

/**
 * Slider — styled horizontal range input.
 * Backed by @radix-ui/react-slider for full keyboard accessibility
 * (arrow keys, Home/End) and proper ARIA value announcements.
 *
 * @param value       controlled number
 * @param onChange    receives the new number (not the event)
 * @param min, max, step standard range props
 * @param format      optional (v) => string for the value bubble
 * @param showValue   show the trailing value bubble (default true)
 * @param label       optional small label above the track
 * @param size        'sm' | 'md'
 */
const Slider = forwardRef(function Slider(
  {
    value,
    onChange,
    min = 0,
    max = 100,
    step = 1,
    format = (v) => v,
    showValue = true,
    label = null,
    size = 'md',
    className = '',
    ...rest
  },
  ref,
) {
  const id = useId();
  const isSm = size === 'sm';

  return (
    <div className={`flex w-full flex-col gap-[var(--space-1)] ${className}`}>
      {label && (
        <label
          htmlFor={id}
          className="text-[length:var(--text-xs)] font-semibold tracking-[0.02em] text-fg-muted"
        >
          {label}
        </label>
      )}
      <div className="flex items-center gap-[var(--space-3)]">
        <RadixSlider.Root
          ref={ref}
          id={id}
          className="relative flex h-5 flex-1 cursor-pointer touch-none select-none items-center"
          value={[Number(value)]}
          onValueChange={([v]) => onChange?.(v)}
          min={min}
          max={max}
          step={step}
          {...rest}
        >
          <RadixSlider.Track
            className={`relative grow rounded-[2px] bg-[rgba(255,255,255,0.08)] ${isSm ? 'h-[2px]' : 'h-[3px]'}`}
          >
            <RadixSlider.Range className="absolute h-full rounded-[2px] bg-brand" />
          </RadixSlider.Track>
          <RadixSlider.Thumb className="block h-3 w-3 cursor-pointer rounded-full border-2 border-bg bg-fg shadow-[var(--shadow-sm)] outline-none [transition:transform_var(--dur-fast)_var(--ease-spring),background_var(--dur-fast)] hover:[transform:scale(1.25)] focus-visible:shadow-[var(--focus-ring)] active:bg-brand active:[transform:scale(1.1)]" />
        </RadixSlider.Root>
        {showValue && (
          <span
            className={`min-w-[2em] shrink-0 rounded-sm border border-border bg-bg-elev-2 text-center font-mono text-fg tabular-nums ${
              isSm
                ? 'px-1 py-0 text-[length:var(--text-2xs)]'
                : 'px-[5px] py-px text-[length:var(--text-xs)]'
            }`}
            aria-live="polite"
          >
            {format(value)}
          </span>
        )}
      </div>
    </div>
  );
});

export default Slider;
