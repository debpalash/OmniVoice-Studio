import { describe, it, expect } from 'vitest';
import { isPlatformPick } from '../components/WizardLibrary';

// The first-run "Models & engines" wizard surfaces platform-tuned optional
// models (e.g. MLX Whisper on Apple Silicon) by default and folds only the
// universal long tail. isPlatformPick is the predicate that drives that split.
describe('isPlatformPick — surface platform-tuned models by default', () => {
  const macTags = ['darwin', 'darwin-arm64'];

  it('matches a model explicitly tagged for this host', () => {
    expect(isPlatformPick({ platforms: ['darwin-arm64'] }, macTags)).toBe(true);
  });

  it('rejects a model tagged for a different platform', () => {
    expect(isPlatformPick({ platforms: ['cuda'] }, macTags)).toBe(false);
  });

  it('treats a universal model (no platforms field) as NOT a pick — it rides the fold', () => {
    expect(isPlatformPick({ repo_id: 'k2-fsa/OmniVoice' }, macTags)).toBe(false);
  });

  it('is safe with empty or absent platform tags', () => {
    expect(isPlatformPick({ platforms: ['darwin-arm64'] }, [])).toBe(false);
    expect(isPlatformPick({ platforms: ['darwin-arm64'] }, undefined)).toBe(false);
  });

  it('is safe with a malformed model', () => {
    expect(isPlatformPick(null, macTags)).toBe(false);
    expect(isPlatformPick({ platforms: 'darwin-arm64' }, macTags)).toBe(false); // string, not array
  });

  it('matches when ANY of the model platforms intersects the host tags', () => {
    expect(isPlatformPick({ platforms: ['cuda', 'darwin-arm64'] }, macTags)).toBe(true);
  });
});
