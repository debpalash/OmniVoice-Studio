import { isTauri } from './media';

export async function askConfirm(message, title = 'Confirm') {
  if (isTauri) {
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return await confirm(message, { title });
  }
  return Promise.resolve(window.confirm(message));
}
