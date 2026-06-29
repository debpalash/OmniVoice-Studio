import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Settings2, Globe, Palette } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import i18n, { LANGUAGES } from '../../i18n';
import { useSystemInfo, queryKeys } from '../../api/hooks';
import { Button, Badge, Select } from '../../ui';
import { SettingsSection, SettingRow, SettingsInput, Collapsible } from './primitives';
import { useAppStore } from '../../store';

export default function GeneralTab() {
  const { t } = useTranslation();
  const locale = useAppStore(s => s.locale);
  const setLocale = useAppStore(s => s.setLocale);
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);
  const { data: sysInfo } = useSystemInfo();
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxySaved, setProxySaved] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffmpegSaving, setFfmpegSaving] = useState(false);
  const queryClient = useQueryClient();

  // Sync inputs with persisted values from backend on load
  useEffect(() => {
    if (!proxyUrl && !proxySaved) setProxyUrl(sysInfo?.proxy_url || '');
  }, [sysInfo?.proxy_url]);

  useEffect(() => {
    if (!ffmpegPath) setFfmpegPath(sysInfo?.ffmpeg_path || '');
  }, [sysInfo?.ffmpeg_path]);

  const ffmpegOk = sysInfo?.ffmpeg_ok;
  const ffmpegCurrent = sysInfo?.ffmpeg_path;

  const saveFfmpeg = async () => {
    const value = ffmpegPath.trim();
    setFfmpegSaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      await apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'FFMPEG_PATH', value }),
      });
      toast.success(t('settings.ffmpeg_saved'));
      setFfmpegPath('');
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) { toast.error(t('settings.save_failed', { message: e.message })); }
    finally { setFfmpegSaving(false); }
  };

  const handleLocaleChange = (e) => {
    const id = e.target.value;
    setLocale(id);
    i18n.changeLanguage(id);
  };

  const saveProxy = async () => {
    const value = proxyUrl.trim();
    setProxySaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      const setEnv = (key, val) => apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      });
      await setEnv('HTTP_PROXY', value);
      await Promise.all([
        setEnv('HTTPS_PROXY', value),
        setEnv('ALL_PROXY', value),
        setEnv('http_proxy', value),
        setEnv('https_proxy', value),
        setEnv('all_proxy', value),
      ]);
      toast.success(t('settings.proxy_saved'));
      setProxySaved(true);
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) { toast.error(t('settings.save_failed', { message: e.message })); }
    finally { setProxySaving(false); }
  };

  const clearProxy = async () => {
    setProxySaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      const setEnv = (key, val) => apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      });
      await Promise.all([
        setEnv('HTTP_PROXY', ''),
        setEnv('HTTPS_PROXY', ''),
        setEnv('ALL_PROXY', ''),
        setEnv('http_proxy', ''),
        setEnv('https_proxy', ''),
        setEnv('all_proxy', ''),
      ]);
      setProxyUrl('');
      setProxySaved(false);
      toast.success(t('settings.proxy_cleared'));
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) { toast.error(t('settings.clear_failed', { message: e.message })); }
    finally { setProxySaving(false); }
  };

  return (
    <SettingsSection icon={Settings2} title={t('settings.general')}>
      <SettingRow
        icon={Globe}
        title={t('settings.language')}
        control={
          <Select size="sm" value={locale} onChange={handleLocaleChange}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </Select>
        }
      />
      <SettingRow
        icon={Palette}
        title={t('settings.theme')}
        control={
          <Select size="sm" value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="gruvbox">Gruvbox</option>
            <option value="midnight">Midnight</option>
            <option value="nord">Nord</option>
            <option value="solarized">Solarized</option>
            <option value="rose-pine">Rose Pine</option>
            <option value="catppuccin">Catppuccin</option>
          </Select>
        }
      />

      <Collapsible title={t('settings.advanced')} icon={Settings2}>
        <SettingRow
          align="start"
          className="st-row--stack"
          title={
            <>
              {t('settings.proxy')}
              {proxySaved && <Badge tone="success" size="xs">{t('credentials.saved')}</Badge>}
            </>
          }
          note={t('settings.proxy_desc')}
          control={
            <>
              <SettingsInput
                placeholder="http://127.0.0.1:7890 or socks5://127.0.0.1:7890"
                value={proxyUrl}
                onChange={e => setProxyUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveProxy()}
              />
              <Button size="sm" variant="subtle" onClick={saveProxy} loading={proxySaving} disabled={!proxyUrl.trim()}>
                {t('credentials.save')}
              </Button>
              {proxySaved && (
                <Button size="sm" variant="ghost" onClick={clearProxy} loading={proxySaving}>
                  {t('settings.proxy_clear')}
                </Button>
              )}
            </>
          }
        />

        <SettingRow
          align="start"
          className="st-row--stack"
          title={
            <>
              {t('settings.ffmpeg')}
              <Badge tone={ffmpegOk ? 'success' : 'warn'} size="xs">
                {ffmpegOk ? t('settings.ffmpeg_found') : t('settings.ffmpeg_missing')}
              </Badge>
            </>
          }
          note={ffmpegCurrent ? `${t('settings.ffmpeg_current')}: ${ffmpegCurrent}` : t('settings.ffmpeg_desc')}
          control={
            <>
              <SettingsInput
                placeholder="D:\ffmpeg\bin\ffmpeg.exe"
                value={ffmpegPath}
                onChange={e => setFfmpegPath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveFfmpeg()}
              />
              <Button size="sm" variant="subtle" onClick={saveFfmpeg} loading={ffmpegSaving} disabled={!ffmpegPath.trim()}>
                {t('credentials.save')}
              </Button>
            </>
          }
        />
      </Collapsible>
    </SettingsSection>
  );
}
