import { apiJson, apiPost, apiFetch } from './client';

export interface GalleryCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export interface GalleryVoice {
  id: string;
  name: string;
  character: string;
  category: string;
  source_type: string;
  source_url?: string;
  audio_path: string;
  duration: number;
  description?: string;
  thumbnail?: string;
  tags: string[];
  is_favorite?: boolean;
  created_at: number;
}

export const listCategories = (): Promise<GalleryCategory[]> => apiJson('/gallery/categories');

export const listGalleryVoices = (params?: { category?: string; search?: string; limit?: number }): Promise<GalleryVoice[]> => {
  const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
  return apiJson(`/gallery/voices${query}`);
};

export const getGalleryVoice = (voiceId: string): Promise<GalleryVoice> => apiJson(`/gallery/voices/${voiceId}`);

export const deleteGalleryVoice = (voiceId: string): Promise<{ success: boolean }> => 
  apiFetch(`/gallery/voices/${voiceId}`, { method: 'DELETE' }).then(r => r.json());

export interface YoutubeSearchResult {
  title: string;
  video_id: string;
  duration: string | null;
  thumbnail: string | null;
}

export const searchYoutube = async (
  query: string, 
  category: string, 
  maxResults: number = 5
): Promise<{ results: YoutubeSearchResult[]; query: string; category: string }> => {
  const url = `/gallery/search/youtube?query=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&max_results=${maxResults}`;
  return apiJson(url, { method: 'POST' });
};

export interface DownloadParams {
  video_url: string;
  start_time: number;
  duration: number;
  character_name: string;
  category: string;
  description?: string;
}

export const downloadYoutubeClip = async (params: DownloadParams): Promise<{ success: boolean; voice_id: string }> => {
  const url = `/gallery/download?video_url=${encodeURIComponent(params.video_url)}&start_time=${params.start_time}&duration=${params.duration}&character_name=${encodeURIComponent(params.character_name)}&category=${encodeURIComponent(params.category)}&description=${encodeURIComponent(params.description || '')}`;
  return apiJson(url, { method: 'POST' });
};

export const uploadVoiceClip = async (formData: FormData): Promise<{ id: string; name: string }> => 
  apiPost('/gallery/upload', formData);

export const saveVoiceAsProfile = async (voiceId: string, profileName: string): Promise<{ profile_id: string; name: string }> => {
  const url = `/gallery/voices/${voiceId}/save-as-profile?profile_name=${encodeURIComponent(profileName)}`;
  return apiJson(url, { method: 'POST' });
};

export const previewVoiceUrl = (voiceId: string): string => `/gallery/voices/${voiceId}/preview`;

export const updateGalleryVoice = async (
  voiceId: string,
  updates: { name?: string; tags?: string[]; is_favorite?: boolean; description?: string },
): Promise<{ success: boolean; updated: string[] }> =>
  apiFetch(`/gallery/voices/${voiceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).then(r => r.json());

export const batchDeleteGalleryVoices = async (
  ids: string[],
): Promise<{ deleted: number }> =>
  apiFetch('/gallery/voices/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(r => r.json());

export const galleryVoiceToProfile = async (
  voiceId: string,
): Promise<{ success: boolean; profile_id: string; name: string }> =>
  apiFetch(`/gallery/voices/${voiceId}/to-profile`, {
    method: 'POST',
  }).then(r => r.json());