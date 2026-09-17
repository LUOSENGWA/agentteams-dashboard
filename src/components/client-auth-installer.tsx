'use client';

import { useEffect } from 'react';
import { installClientAuthFetch } from '@/lib/client-auth-fetch';

/**
 * Installs the client-side credential injection patch (F7) exactly once per
 * page load. Renders nothing. Safe in both deployment shapes — inert in
 * stateful mode (server credentials always win server-side).
 */
export function ClientAuthInstaller() {
  useEffect(() => {
    installClientAuthFetch();
  }, []);
  return null;
}
