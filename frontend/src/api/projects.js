import { apiJson, apiPost, apiFetch } from './client';

export async function listProjects() {
  return apiJson('/projects');
}

export async function saveProject(body, id) {
  if (id) return apiPost(`/projects/${id}`, body, { method: 'PUT' });
  return apiPost('/projects', body);
}

export async function loadProject(id) {
  return apiJson(`/projects/${id}`);
}

export async function deleteProject(id) {
  return apiFetch(`/projects/${id}`, { method: 'DELETE' });
}
