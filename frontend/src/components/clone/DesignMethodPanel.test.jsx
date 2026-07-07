import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DesignMethodPanel from './DesignMethodPanel';

// #983: "Cannot read properties of undefined (reading 'replace')" — the
// identity panel crashed whenever vdStates was missing one of the 6
// CATEGORIES keys (a design profile saved by an older/foreign client, or a
// stale localStorage shape). The label helper called `val.replace(...)` on
// an undefined category value. This regression-tests the render guard added
// to DesignMethodPanel.jsx directly, independent of the upstream data-shape
// fixes in useProfiles.js / useAppData.js / profiles.py.

// A minimal i18next-compatible mock: returns the defaultValue if given, else
// echoes the key back (mirrors i18next's behavior for a missing translation,
// which is what `optLabel`'s `tl !== tKey` check relies on).
const t = (key, opts) => opts?.defaultValue ?? key;

function setup(vdStates, props = {}) {
  return render(
    <DesignMethodPanel
      t={t}
      describeText=""
      onDescribeChange={vi.fn()}
      describeMatchedAny={false}
      describeUnmatched={[]}
      chipPersonalities={[]}
      activePersonality={null}
      applyPersonality={vi.fn()}
      applyPreset={vi.fn()}
      identityOpen={true}
      setIdentityOpen={vi.fn()}
      identityRecipe="test recipe"
      vdStates={vdStates}
      setVdStates={vi.fn()}
      onChipKeyDown={vi.fn()}
      showSaveProfile={false}
      setShowSaveProfile={vi.fn()}
      profileName=""
      setProfileName={vi.fn()}
      handleSaveDesignProfile={vi.fn()}
      instruct=""
      language="Auto"
      {...props}
    />,
  );
}

describe('DesignMethodPanel — #983 partial vdStates crash', () => {
  it('does not throw when vdStates is missing 5 of the 6 CATEGORIES keys', () => {
    // Only Gender is set — Age, Pitch, Style, EnglishAccent, ChineseDialect
    // are all undefined, exercising both the chip-based and <select>-based
    // ("many" options) render paths.
    expect(() => setup({ Gender: 'male' })).not.toThrow();
  });

  it('does not throw when vdStates is a fully empty object', () => {
    expect(() => setup({})).not.toThrow();
  });

  it('still renders category labels and the identity recipe with a partial shape', () => {
    const { container } = setup({ Gender: 'male' });
    expect(screen.getByText('test recipe')).toBeInTheDocument();
    // The label text sits alongside a sibling <span> kicker, so assert via
    // textContent rather than getByText's exact-node matching.
    expect(container.textContent).toContain('clone.cat_Gender');
  });
});
