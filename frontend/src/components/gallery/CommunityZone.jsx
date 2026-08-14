import React, { useMemo } from 'react';
import { Loader, Send } from 'lucide-react';
import { useCommunityItems } from '../../api/hooks';
import { communitySubmitUrl } from '../../api/community';
import { openExternal } from '../../api/external';
import ArchetypeCard from './ArchetypeCard';

const itemKey = (item) => `community:${item._source_repo || item.source || 'default'}:${item.id}`;

// ── Community zone (marketplace) ─────────────────────────────────────────────
export default function CommunityZone({
  t,
  playingId,
  loadingPreviewId,
  favorites,
  toggleFavorite,
  onPreview,
  flash,
  onDesign,
  onUse,
  onUseInStories,
  onUseAsAudiobookDefault,
  materializingId,
}) {
  const itemsQ = useCommunityItems({ limit: 100 });
  const items = itemsQ.data?.items || [];
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const submit = async (type) => {
    try {
      const { url } = await communitySubmitUrl(type);
      await openExternal(url);
    } catch {
      flash(t('gallery.submit_failed', { defaultValue: 'Could not open the submission form.' }));
    }
  };

  const submitBtn =
    'inline-flex items-center gap-[5px] px-[10px] py-[6px] border border-transparent bg-white/[0.03] text-[var(--text-primary)] rounded-[8px] text-[0.7rem] cursor-pointer transition-colors hover:border-[color:var(--accent)] hover:text-[var(--accent)]';

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      <div className="shrink-0 px-[10px] py-[8px] mb-[8px] bg-bg-elev-2 rounded-[8px] text-[0.72rem] text-[var(--text-secondary)] leading-[1.4] flex items-center justify-between gap-[12px] flex-wrap">
        <span>
          {t('gallery.community_explainer', {
            defaultValue:
              'Designed presets and recorded voices shared by the community, loaded from the omnivoice-gallery.',
          })}
        </span>
        <div className="flex gap-[6px] shrink-0">
          <button className={submitBtn} onClick={() => submit('preset')}>
            <Send size={13} /> {t('gallery.submit_preset', { defaultValue: 'Submit a preset' })}
          </button>
          <button className={submitBtn} onClick={() => submit('voice')}>
            <Send size={13} /> {t('gallery.submit_voice', { defaultValue: 'Submit a voice' })}
          </button>
        </div>
      </div>

      {itemsQ.isLoading ? (
        <div className="flex items-center justify-center p-[24px] text-[var(--text-secondary)]">
          <Loader className="spin" size={18} />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-[16px] py-[32px] text-[var(--text-secondary)] text-center">
          {t('gallery.community_empty', {
            defaultValue:
              'No community voices loaded yet — connect to the internet and reopen, or be the first to submit one.',
          })}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-[10px]">
          {items.map((it) => (
            <ArchetypeCard
              key={itemKey(it)}
              a={it}
              t={t}
              favoriteId={itemKey(it)}
              isFavorite={favSet.has(itemKey(it))}
              isPlaying={playingId === itemKey(it)}
              isLoadingPreview={loadingPreviewId === itemKey(it)}
              previewLocked={Boolean(loadingPreviewId)}
              onToggleFavorite={toggleFavorite}
              onPreview={onPreview}
              onUse={onUse}
              onDesign={it.type === 'preset' && it.instruct ? onDesign : null}
              onUseInStories={onUseInStories}
              onUseAsAudiobookDefault={onUseAsAudiobookDefault}
              isMaterializing={materializingId === it.id}
              materializationLocked={Boolean(materializingId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
