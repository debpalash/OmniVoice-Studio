import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAppStore } from '../store';
import { Button } from '../ui';

/** Keep project editors unmounted until IndexedDB has been read successfully. */
export default function LongformPersistenceGate({ children }) {
  const { t } = useTranslation();
  const unavailable = useAppStore((state) => state.longformPersistenceError);
  const [retrying, setRetrying] = useState(false);

  if (!unavailable) return children;

  const retry = async () => {
    setRetrying(true);
    try {
      await useAppStore.persist.rehydrate();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section
        className="w-full max-w-lg rounded-xl border border-border bg-card p-6 text-card-foreground shadow-lg"
        role="alert"
        data-testid="longform-persistence-gate"
      >
        <AlertTriangle className="mb-4 text-warning" aria-hidden="true" />
        <h1 className="text-lg font-semibold">
          {t('longformPersistence.storage_unavailable_title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('longformPersistence.storage_unavailable_body')}
        </p>
        <Button className="mt-5" variant="primary" loading={retrying} onClick={retry}>
          {retrying ? t('bootstrap.retrying') : t('bootstrap.retry')}
        </Button>
      </section>
    </main>
  );
}
