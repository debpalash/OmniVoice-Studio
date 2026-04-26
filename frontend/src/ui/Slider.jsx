import React, { forwardRef, useId } from 'react';
import * as RadixSlider from '@radix-ui/react-slider';
import './Slider.css';

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

  return (
    <div className={`ui-slider ui-slider--size-${size} ${className}`}>
      {label && <label htmlFor={id} className="ui-slider__label">{label}</label>}
      <div className="ui-slider__row">
        <RadixSlider.Root
          ref={ref}
          id={id}
          className="ui-slider__root"
          value={[Number(value)]}
          onValueChange={([v]) => onChange?.(v)}
          min={min}
          max={max}
          step={step}
          {...rest}
        >
          <RadixSlider.Track className="ui-slider__track">
            <RadixSlider.Range className="ui-slider__range" />
          </RadixSlider.Track>
          <RadixSlider.Thumb className="ui-slider__thumb" />
        </RadixSlider.Root>
        {showValue && (
          <span className="ui-slider__value" aria-live="polite">
            {format(value)}
          </span>
        )}
      </div>
    </div>
  );
});

export default Slider;
