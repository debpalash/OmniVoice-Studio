import React from 'react';

/**
 * FooterBtn — the gradient-per-tone download button family in the action footer.
 * Uses the legacy .btn-primary as the shape/hover base, just picks a tone class.
 * forwardRef so <Menu> can wire its triggerRef to the underlying button —
 * without this the Export menu can't compute coords and never opens.
 */
const FooterBtn = React.forwardRef(function FooterBtn(
  { tone = 'idle', sm = false, disabled, onClick, icon, label, ...rest },
  ref,
) {
  const cls = [
    'btn-primary',
    'dub-footer-btn',
    sm && 'dub-footer-btn--sm',
    `dub-footer-btn--${tone}`,
  ].filter(Boolean).join(' ');
  return (
    <button ref={ref} className={cls} disabled={disabled} onClick={onClick} {...rest}>
      {icon} {label}
    </button>
  );
});

export default FooterBtn;
