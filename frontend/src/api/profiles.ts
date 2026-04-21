import { apiJson, apiPost, apiFetch } from './client';
import type { Profile, ProfileUsage } from './types';

export async function listProfiles(): Promise<Profile[]> {
  return apiJson<Profile[]>('/profiles');
}

export async function getProfile(id: string): Promise<Profile> {
  return apiJson<Profile>(`/profiles/${id}`);
}

export async function getProfileUsage(id: string): Promise<ProfileUsage> {
  return apiJson<ProfileUsage>(`/profiles/${id}/usage`);
}

export async function createProfile(formData: FormData): Promise<Profile> {
  return apiPost<Profile>('/profiles', formData);
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
  const r = await apiFetch(`/profiles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return r.json() as Promise<Profile>;
}

export async function deleteProfile(id: string): Promise<Response> {
  return apiFetch(`/profiles/${id}`, { method: 'DELETE' });
}

export async function lockProfile(id: string, formData: FormData): Promise<unknown> {
  return apiPost(`/profiles/${id}/lock`, formData);
}

export async function unlockProfile(id: string): Promise<unknown> {
  return apiPost(`/profiles/${id}/unlock`);
}
