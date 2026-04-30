import React, { useState, useEffect } from 'react';
import {
  Search, Download, Play, Pause, Trash2, User, Film,
  Clock, Grid, List, X, Save, Loader, Music, Sparkles,
  Star, Crown, Gamepad2, BookOpen, Mic, RotateCcw,
  FileAudio, UserPlus, MoreVertical, Scissors,
} from 'lucide-react';
import { Button, Input } from '../ui';
import { searchYoutube, downloadYoutubeClip, deleteGalleryVoice, saveVoiceAsProfile, uploadVoiceClip } from '../api/gallery';
import { useGalleryCategories, useGalleryVoices } from '../api/hooks';
import AudioTrimmer from '../components/AudioTrimmer';
import './VoiceGallery.css';
import { askConfirm } from '../utils/dialog';

// Check if running in Tauri
const isTauri = window.__TAURI__ != null || window.location.protocol === 'tauri:';

const CATEGORY_ICONS = {
  disney: Film,
  anime: Star,
  marvel: Crown,
  celebs: Sparkles,
  politicians: Mic,
  news: User,
  gaming: Gamepad2,
  books: BookOpen,
};

export default function VoiceGallery() {
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState(null);
  const [playingAudio, setPlayingAudio] = useState(null);
  const [viewMode, setViewMode] = useState('list');
  const [trimmingVoice, setTrimmingVoice] = useState(null);

  const { data: categories = [] } = useGalleryCategories();
  
  const queryParams = React.useMemo(() => {
    const p = {};
    if (selectedCategory) p.category = selectedCategory;
    if (searchQuery.trim()) p.search = searchQuery.trim();
    return p;
  }, [selectedCategory, searchQuery]);

  const voicesQuery = useGalleryVoices(queryParams);
  const voices = voicesQuery.data || [];
  const isLoadingVoices = voicesQuery.isLoading;

  const loadVoices = () => voicesQuery.refetch();

  const handleSearch = async () => {
    setIsSearching(true);
    try {
      const results = await searchYoutube(searchQuery.trim() || selectedCategory || 'famous voice', selectedCategory || 'celebs', 10);
      setSearchResults(results.results || []);
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDownload = async (videoInfo) => {
    setIsDownloading(true);
    try {
      const charName = videoInfo.title.substring(0, 40);
      await downloadYoutubeClip({
        video_url: `https://youtube.com/watch?v=${videoInfo.video_id}`,
        start_time: 0,
        duration: Math.min(parseFloat(videoInfo.duration) || 10, 30),
        character_name: charName,
        category: selectedCategory || 'celebs',
        description: videoInfo.title,
      });
      loadVoices();
      setSearchResults([]);
    } catch (e) {
      console.error('Download failed:', e);
      alert('Download failed: ' + e.message);
    } finally {
      setIsDownloading(false);
    }
  };

  const playVoice = async (voice) => {
    if (playingVoiceId === voice.id) {
      if (playingAudio) {
        playingAudio.pause();
        setPlayingAudio(null);
      }
      setPlayingVoiceId(null);
      return;
    }

    if (playingAudio) {
      playingAudio.pause();
    }

    try {
      const { apiUrl } = await import('../api/client');
      const response = await fetch(apiUrl(`/gallery/voices/${voice.id}/preview`));
      const blob = await response.blob();
      
      if (isTauri) {
        // Use Web Audio API for Tauri (blob URLs blocked)
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') await ctx.resume();
        try {
          const buf = await blob.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf);
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.start(0);
          src.onended = () => {
            setPlayingVoiceId(null);
            ctx.close();
          };
          setPlayingVoiceId(voice.id);
        } catch (e) {
          console.error('Web Audio decode failed:', e);
          ctx.close();
          // Fallback to URL
          const url = URL.createObjectURL(blob);
          const a = new Audio(url);
          a.onended = () => {
            setPlayingVoiceId(null);
            URL.revokeObjectURL(url);
          };
          await a.play();
          setPlayingAudio(a);
          setPlayingVoiceId(voice.id);
        }
      } else {
        // Standard approach for browser
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        a.onended = () => {
          setPlayingVoiceId(null);
          URL.revokeObjectURL(url);
        };
        a.onerror = () => {
          setPlayingVoiceId(null);
          URL.revokeObjectURL(url);
        };
        await a.play();
        setPlayingAudio(a);
        setPlayingVoiceId(voice.id);
      }
    } catch (e) {
      console.error('Playback failed:', e);
    }
  };

  const handleSaveAsProfile = async (voice) => {
    const name = prompt(`Enter a name for this voice profile:`, voice.name);
    if (!name) return;
    try {
      await saveVoiceAsProfile(voice.id, name);
      alert('Voice saved as profile!');
    } catch (e) {
      alert('Failed to save profile');
    }
  };

  const handleDeleteVoice = async (voice) => {
    if (!(await askConfirm(`Delete "${voice.name}"?`))) return;
    try {
      await deleteGalleryVoice(voice.id);
      loadVoices();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  const handleCropClick = async (voice) => {
    try {
      const { apiUrl } = await import('../api/client');
      const response = await fetch(apiUrl(`/gallery/voices/${voice.id}/preview`));
      if (!response.ok) throw new Error("Failed to fetch audio");
      const blob = await response.blob();
      const file = new File([blob], `${voice.name}.wav`, { type: 'audio/wav' });
      setTrimmingVoice({ voice, file });
    } catch (e) {
      alert("Failed to load audio for trimming: " + e.message);
    }
  };

  const handleConfirmTrim = async (trimmedFile) => {
    if (!trimmingVoice) return;
    try {
      const { voice } = trimmingVoice;
      const formData = new FormData();
      formData.append('name', `${voice.name} (Cropped)`);
      formData.append('character', voice.character);
      formData.append('category', voice.category);
      formData.append('description', voice.description || '');
      formData.append('audio', trimmedFile);
      
      await uploadVoiceClip(formData);
      
      loadVoices();
      setTrimmingVoice(null);
    } catch (e) {
      alert("Failed to upload cropped voice: " + e.message);
    }
  };

  const onSearchKey = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="voice-gallery">
      <div className="gallery-header">
        <div className="header-top">
          <div className="header-text">
            <h2>Voice Gallery</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => voicesQuery.refetch()} title="Reload">
            <RotateCcw size={14} />
          </Button>
        </div>
      </div>

      <div className="gallery-search">
        <div className="search-row">
          <Input
            placeholder="Search YouTube..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <Button onClick={handleSearch} disabled={isSearching} size="sm">
            {isSearching ? <Loader size={14} className="spin" /> : <Search size={14} />}
          </Button>
        </div>

        <div className="categories-row">
          {categories.map((cat) => {
            const Icon = CATEGORY_ICONS[cat.id] || Music;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                className={`category-chip ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedCategory(isSelected ? null : cat.id)}
              >
                <Icon size={12} />
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {searchResults.length > 0 && (
        <div className="search-results-panel">
          <div className="panel-header">
            <span>YouTube Results ({searchResults.length})</span>
            <button className="close-btn" onClick={() => setSearchResults([])}><X size={14} /></button>
          </div>
          <div className="results-list">
            {searchResults.map((result, idx) => (
              <div key={idx} className="result-row">
                <div className="result-info">
                  <span className="result-title">{result.title}</span>
                  <span className="result-meta">{result.duration || '?'}s</span>
                </div>
                <Button size="sm" onClick={() => handleDownload(result)} disabled={isDownloading}>
                  <Download size={12} /> Get
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="gallery-content">
        <div className="content-header">
          <div className="content-title">
            {selectedCategory 
              ? categories.find(c => c.id === selectedCategory)?.name 
              : 'All Voices'}
            <span className="count">({voices.length})</span>
          </div>
          <div className="view-toggle">
            <button 
              className={viewMode === 'list' ? 'active' : ''} 
              onClick={() => setViewMode('list')}
              title="List"
            >
              <List size={14} />
            </button>
            <button 
              className={viewMode === 'grid' ? 'active' : ''} 
              onClick={() => setViewMode('grid')}
              title="Grid"
            >
              <Grid size={14} />
            </button>
          </div>
        </div>

        {isLoadingVoices ? (
          <div className="loading"><Loader size={20} className="spin" /></div>
        ) : voices.length === 0 ? (
          <div className="empty">
            <FileAudio size={24} />
            <p>No voices yet</p>
            <p>Search above to download clips</p>
          </div>
        ) : (
          <div className={`voice-list ${viewMode}`}>
            {voices.map((voice, idx) => (
              <div key={voice.id} className="voice-card">
                <button 
                  className="voice-play" 
                  onClick={() => playVoice(voice)}
                  title={playingVoiceId === voice.id ? 'Pause' : 'Play'}
                >
                  {playingVoiceId === voice.id ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <div className="voice-info">
                  <span className="voice-name">{voice.name}</span>
                  <span className="voice-meta">
                    <Clock size={10} /> {voice.duration.toFixed(0)}s
                  </span>
                </div>
                <div className="voice-actions">
                  <button 
                    className="action-btn" 
                    onClick={() => handleSaveAsProfile(voice)}
                    title="Clone profile"
                  >
                    <UserPlus size={12} />
                  </button>
                  <button 
                    className="action-btn" 
                    onClick={() => handleCropClick(voice)}
                    title="Crop audio"
                  >
                    <Scissors size={12} />
                  </button>
                  <button 
                    className="action-btn danger" 
                    onClick={() => handleDeleteVoice(voice)}
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {trimmingVoice && (
        <AudioTrimmer
          file={trimmingVoice.file}
          maxSeconds={60}
          onConfirm={handleConfirmTrim}
          onCancel={() => setTrimmingVoice(null)}
        />
      )}
    </div>
  );
}