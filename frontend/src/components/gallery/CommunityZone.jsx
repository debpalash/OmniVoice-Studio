import React, { useMemo } from 'react';
import { Loader, Send } from 'lucide-react';
import { useCommunityItems } from '../../api/hooks';
import { addCommunityItem, communitySubmitUrl } from '../../api/community';
import { openExternal } from '../../api/external';
import ArchetypeCard from './ArchetypeCard';

// ── Community zone (marketplace) ─────────────────────────────────────────────
export default function CommunityZone({ t, playingId, loadingPreviewId, favorites, toggleFavorite, onPlayAudio, flash, onDesign }) {
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

  return (
    <div className="gallery-content gallery-scroll">
      <div className="import-explainer community-explainer">
        <span>{t('gallery.community_explainer', { defaultValue: 'Designed presets and recorded voices shared by the community, loaded from the omnivoice-gallery.' })}</span>
        <div className="submit-actions">
          <button className="submit-btn" onClick={() => submit('preset')}>
            <Send size={13} /> {t('gallery.submit_preset', { defaultValue: 'Submit a preset' })}
          </button>
          <button className="submit-btn" onClick={() => submit('voice')}>
            <Send size={13} /> {t('gallery.submit_voice', { defaultValue: 'Submit a voice' })}
          </button>
        </div>
      </div>

      {itemsQ.isLoading ? (
        <div className="loading"><Loader className="spin" size={18} /></div>
      ) : items.length === 0 ? (
        <div className="empty">
          {t('gallery.community_empty', { defaultValue: 'No community voices loaded yet — connect to the internet and reopen, or be the first to submit one.' })}
        </div>
      ) : (
        <div className="archetype-grid grid">
          {items.map((it) => (
            <ArchetypeCard
              key={it.id}
              a={it}
              t={t}
              viewMode="grid"
              isFavorite={favSet.has(it.id)}
              isPlaying={playingId === it.id}
              isLoadingPreview={loadingPreviewId === it.id}
              onToggleFavorite={toggleFavorite}
              onPreview={(item) => (item.audio?.url
                ? onPlayAudio(item.audio.url, item.id)
                : flash(t('gallery.no_preview', { defaultValue: 'No preview — add it with "Use voice" to hear it.' })))}
              onUse={async (item) => {
                try {
                  const r = await addCommunityItem(item.id, item.name);
                  flash(t('gallery.saved_as_profile', { defaultValue: 'Added "{{name}}" to your voices.', name: r.name }));
                } catch {
                  flash(t('gallery.use_failed', { defaultValue: 'Could not add that voice.' }));
                }
              }}
              onDesign={(item) => (item.instruct
                ? onDesign(item.instruct)
                : flash(t('gallery.no_designer', { defaultValue: 'Recorded voice — use "Use voice" instead.' })))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
