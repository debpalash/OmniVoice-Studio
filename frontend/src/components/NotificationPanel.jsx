/**
 * NotificationPanel — bell icon in the header that opens the
 * Notifications tab in the footer status bar.
 */
import React from 'react';
import { Bell } from 'lucide-react';
import { useNotifications } from '../api/hooks';
import './NotificationPanel.css';

export default function NotificationPanel() {
  // Shared TanStack Query cache entry with LogsFooter — one 30s poll.
  const { data } = useNotifications();
  const notifs = data?.notifications || [];
  const count = notifs.length;
  const hasErrors = notifs.some(n => n.level === 'error');
  const hasWarns = notifs.some(n => n.level === 'warn');

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
