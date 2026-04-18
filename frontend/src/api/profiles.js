import { apiJson, apiPost, apiFetch } from './client';

export async function listProfiles() {
  return apiJson('/profiles');
}

export async function createProfile(formData) {
  return apiPost('/profiles', formData);
}

export async function deleteProfile(id) {
  return apiFetch(`/profiles/${id}`, { method: 'DELETE' });
}

export async function lockProfile(id, formData) {
  return apiPost(`/profiles/${id}/lock`, formData);
}

export async function unlockProfile(id) {
  return apiPost(`/profiles/${id}/unlock`);
}
