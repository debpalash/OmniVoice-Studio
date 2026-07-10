/**
 * Settings → Network.
 *
 * The proxy + FFmpeg-path controls that used to live in GeneralTab's "Advanced"
 * collapsible, promoted to their own top-level category. Logic is unchanged —
 * both persist via the backend `/system/set-env` durable env writer and
 * invalidate the systemInfo query so badges refresh.
 *
 * FFmpeg takes effect on the next backend start (durable env), so it carries a
 * RestartBadge; the proxy applies to subsequent downloads immediately.
 */
import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Wifi, Globe, Film } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSystemInfo, queryKeys } from '../../api/hooks';
import { Button, Badge } from '../../ui';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import RestartBadge from './RestartBadge';

/** Platform-appropriate FFmpeg example path (sysInfo.platform = Python's sys.platform). */
export function ffmpegPlaceholder(platform) {
  if (typeof platform === 'string' && platform.startsWith('win')) {
    return 'C:\\ffmpeg\\bin\\ffmpeg.exe';
  }
  if (platform === 'darwin') return '/opt/homebrew/bin/ffmpeg';
  return '/usr/bin/ffmpeg';
}

export default function NetworkTab() {
  const { t } = useTranslation();
  const { data: sysInfo } = useSystemInfo();
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyCleared, setProxyCleared] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffmpegSaving, setFfmpegSaving] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!proxyUrl && !proxySaved && !proxyCleared) setProxyUrl(sysInfo?.proxy_url || '');
  }, [sysInfo?.proxy_url]);

  useEffect(() => {
    if (!ffmpegPath) setFfmpegPath(sysInfo?.ffmpeg_path || '');
  }, [sysInfo?.ffmpeg_path]);

  const ffmpegOk = sysInfo?.ffmpeg_ok;
  const ffmpegCurrent = sysInfo?.ffmpeg_path;
  // "A proxy is configured" must survive an app reload: derive it from the
  // backend-persisted value, not only from a save in this session — otherwise
  // the Clear button (and the "Set" badge) vanish on reload with the proxy
  // still active and no way to remove it.
  const proxyConfigured = !proxyCleared && (proxySaved || Boolean(sysInfo?.proxy_url));

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
    } catch (e) {
      toast.error(t('settings.save_failed', { message: e.message }));
    } finally {
      setFfmpegSaving(false);
    }
  };

  const saveProxy = async () => {
    const value = proxyUrl.trim();
    setProxySaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      const setEnv = (key, val) =>
        apiFetch('/system/set-env', {
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
      setProxyCleared(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) {
      toast.error(t('settings.save_failed', { message: e.message }));
    } finally {
      setProxySaving(false);
    }
  };

  const clearProxy = async () => {
    setProxySaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      const setEnv = (key, val) =>
        apiFetch('/system/set-env', {
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
      setProxyCleared(true);
      toast.success(t('settings.proxy_cleared'));
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) {
      toast.error(t('settings.clear_failed', { message: e.message }));
    } finally {
      setProxySaving(false);
    }
  };

  return (
    <SettingsSection
      icon={Wifi}
      title={t('settings.network', { defaultValue: 'Network' })}
      description={t('settings.network_desc', {
        defaultValue: 'Proxy and FFmpeg paths for downloads and media processing.',
      })}
    >
      <SettingRow
        align="start"
        stack
        icon={Globe}
        title={
          <>
            {t('settings.proxy')}
            <RestartBadge applies />
            {proxyConfigured && (
              <Badge tone="success" size="xs">
                {t('credentials.saved')}
              </Badge>
            )}
          </>
        }
        note={t('settings.proxy_desc')}
        control={
          <>
            <SettingsInput
              placeholder="http://127.0.0.1:7890 or socks5://127.0.0.1:7890"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveProxy()}
              aria-label={t('settings.proxy_input_aria', { defaultValue: 'Proxy URL' })}
            />
            <Button
              size="sm"
              variant="subtle"
              onClick={saveProxy}
              loading={proxySaving}
              disabled={!proxyUrl.trim()}
            >
              {t('credentials.save')}
            </Button>
            {proxyConfigured && (
              <Button
                size="sm"
                variant="ghost"
                onClick={clearProxy}
                loading={proxySaving}
                data-testid="proxy-clear"
              >
                {t('settings.proxy_clear')}
              </Button>
            )}
          </>
        }
      />

      <SettingRow
        align="start"
        stack
        icon={Film}
        title={
          <>
            {t('settings.ffmpeg')}
            <Badge tone={ffmpegOk ? 'success' : 'warn'} size="xs">
              {ffmpegOk ? t('settings.ffmpeg_found') : t('settings.ffmpeg_missing')}
            </Badge>
            <RestartBadge />
          </>
        }
        note={
          ffmpegCurrent
            ? `${t('settings.ffmpeg_current')}: ${ffmpegCurrent}`
            : t('settings.ffmpeg_desc')
        }
        control={
          <>
            <SettingsInput
              placeholder={ffmpegPlaceholder(sysInfo?.platform)}
              value={ffmpegPath}
              onChange={(e) => setFfmpegPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveFfmpeg()}
              aria-label={t('settings.ffmpeg_input_aria', { defaultValue: 'FFmpeg path' })}
            />
            <Button
              size="sm"
              variant="subtle"
              onClick={saveFfmpeg}
              loading={ffmpegSaving}
              disabled={!ffmpegPath.trim()}
            >
              {t('credentials.save')}
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
