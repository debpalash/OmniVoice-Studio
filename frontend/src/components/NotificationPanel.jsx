/**
 * NotificationPanel — bell icon in the header that opens the
 * Notifications tab in the footer status bar.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Bell } from 'lucide-react';
import { API } from '../api/client';
import './NotificationPanel.css';

export default function NotificationPanel() {
  const [count, setCount] = useState(0);
  const [hasErrors, setHasErrors] = useState(false);
  const [hasWarns, setHasWarns] = useState(false);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch(`${API}/system/notifications`);
      if (res.ok) {
        const data = await res.json();
        const notifs = data.notifications || [];
        setCount(notifs.length);
        setHasErrors(notifs.some(n => n.level === 'error'));
        setHasWarns(notifs.some(n => n.level === 'warn'));
      }
    } catch {
      // Backend not ready
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const iv = setInterval(fetchCount, 30000);
    return () => clearInterval(iv);
  }, [fetchCount]);

  const openNotifications = () => {
    window.dispatchEvent(new CustomEvent('omni:open-notifications'));
  };

  return (
    <button
      className={`notif-trigger ${count > 0 ? 'notif-trigger--has-items' : ''}`}
      onClick={openNotifications}
      aria-label={`Notifications (${count})`}
      title="Notifications"
    >
      <Bell size={14} />
      {count > 0 && (
        <span className={`notif-badge ${hasErrors ? '' : hasWarns ? 'notif-badge--warn' : ''}`}>
          {count}
        </span>
      )}
    </button>
  );
}
