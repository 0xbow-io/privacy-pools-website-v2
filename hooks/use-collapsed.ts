import { useCallback, useState } from 'react';
import { readCollapsed, writeCollapsed } from '@/services/collapsed-store';

/**
 * Per-section collapse state for the main-page cards, persisted per key in
 * localStorage so people can curate which sections they want to see.
 */
export function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key, undefined, defaultCollapsed));
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(key, next);
      return next;
    });
  }, [key]);
  return [collapsed, toggle];
}
