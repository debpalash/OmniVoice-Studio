import { describe, expect, it } from 'vitest';

import { migrateAppStore } from './index';

describe('long-form v5 migration', () => {
  it('normalizes malformed nested project fields after applying defaults', () => {
    const migrated = migrateAppStore(
      {
        storyProjects: [
          null,
          'bad',
          { id: null, name: null, tracks: 'bad', cast: {}, updatedAt: 'yesterday' },
        ],
      },
      4,
    );
    const projects = migrated.storyProjects ?? [];

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: expect.stringMatching(/^p_/),
      name: 'Untitled',
      tracks: [],
      cast: [],
      mode: 'stories',
      updatedAt: 0,
    });
  });

  it('keeps valid legacy identity and arrays while normalizing corrupt optional objects', () => {
    const migrated = migrateAppStore(
      {
        storyProjects: [
          {
            id: 'p_book',
            name: 'Book',
            tracks: [{ id: 1 }],
            cast: [{ id: 'narrator' }],
            meta: null,
            lexicon: [],
            voiceCast: 'bad',
            updatedAt: Number.NaN,
          },
        ],
      },
      4,
    );
    const projects = migrated.storyProjects ?? [];

    expect(projects[0]).toMatchObject({
      id: 'p_book',
      name: 'Book',
      tracks: [{ id: 1 }],
      cast: [{ id: 'narrator' }],
      meta: {},
      lexicon: {},
      voiceCast: {},
      updatedAt: 0,
    });
  });
});
