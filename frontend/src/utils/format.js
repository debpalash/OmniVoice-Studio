export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, '0')}`;
}

export async function probeAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? a.duration : null));
    a.addEventListener('error', () => done(null));
    a.src = url;
  });
}
