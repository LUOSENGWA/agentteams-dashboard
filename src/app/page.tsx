'use client';

import { useEffect, useState } from 'react';
import { AgentTeamsDashboard } from '@/components/dashboard/agent-teams-dashboard';
import { LoginPage } from '@/components/auth/login-page';
import { BackendSetupPage } from '@/components/setup/backend-setup-page';
import { SetupWizard } from '@/components/setup/setup-wizard';
import { QueryProvider } from '@/lib/query-provider';
import { useAgentTeamsStore } from '@/lib/agentteams-store';
import { SearchProvider } from '@/lib/search-context';
import { apiUrl } from '@/lib/api-base';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/ui/sonner';

type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; username?: string }
  | { status: 'unauthenticated' };

type SetupState =
  | { status: 'loading' }
  | { status: 'required' }
  | { status: 'complete' };

// F1 pre-login backend setup gate: independent of the (post-login)
// controller-side setup wizard above.
type PreSetupState = { status: 'loading' } | { status: 'required' } | { status: 'complete' };

export default function Home() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [setup, setSetup] = useState<SetupState>({ status: 'loading' });
  const [preSetup, setPreSetup] = useState<PreSetupState>({ status: 'loading' });
  // F1e: the login screen can deep-link here (?setup=1) to re-configure
  // backends when an existing deployment is broken or moved.
  const [forceSetup, setForceSetup] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Session check on mount; when authenticated, chain the setup-status check.
    // All setState calls happen in promise callbacks (external system → React).
    fetch(apiUrl('/api/auth/session'), { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.authenticated) {
          setAuth({ status: 'unauthenticated' });
          // F1e: ?setup=1 forces the pre-login backend setup page from the
          // login screen (escape hatch — broken/changed environments).
          const forceSetup = new URLSearchParams(window.location.search).get('setup') === '1';
          setForceSetup(forceSetup);
          // F1: before offering the login form, check whether the dashboard
          // has any usable backend addresses. Standalone installs without
          // env config must configure backends FIRST (token-gated),
          // so unconfigured -> setup page instead of login.
          fetch(apiUrl('/api/agentteams/setup/backends'), { credentials: 'same-origin' })
            .then((res) => res.json().catch(() => null))
            .then((sdata) => {
              if (cancelled) return;
              const required = forceSetup || (sdata && sdata.configured === false);
              setPreSetup({ status: required ? 'required' : 'complete' });
            })
            .catch(() => {
              if (!cancelled) setPreSetup({ status: forceSetup ? 'required' : 'complete' });
            });
          return;
        }
        setAuth({ status: 'authenticated', username: data.username });
        // M19: publish the dashboard level for the UI level gate (nav items).
        // Falls back to 3 (full nav) when the session endpoint predates the
        // level field or in AUTH_DISABLED dev setups.
        useAgentTeamsStore.getState().setUserLevel(data.level ?? 3);
        // Account chip in the header (identity = the session's own username).
        if (data.username) {
          useAgentTeamsStore.getState().setSessionUser(data.username);
        }
        fetch(apiUrl('/api/agentteams/setup/status/'), { credentials: 'same-origin' })
          .then((res) => res.json().catch(() => ({})))
          .then((sdata) => {
            if (cancelled) return;
            setSetup({ status: sdata.setupRequired ? 'required' : 'complete' });
          })
          .catch(() => {
            if (!cancelled) setSetup({ status: 'complete' });
          });
      })
      .catch(() => {
        if (!cancelled) setAuth({ status: 'unauthenticated' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoginSuccess = () => {
    window.location.reload();
  };

  if (auth.status === 'loading' || (auth.status === 'authenticated' && setup.status === 'loading')) {
    return null;
  }

  if (auth.status === 'unauthenticated') {
    if (preSetup.status === 'loading') return null;
    return (
      <ThemeProvider>
        {preSetup.status === 'required' ? (
          <BackendSetupPage onDone={handleLoginSuccess} reconfigure={forceSetup} />
        ) : (
          <LoginPage onLoginSuccess={handleLoginSuccess} />
        )}
        <Toaster position="top-right" richColors />
      </ThemeProvider>
    );
  }

  if (setup.status === 'required') {
    return (
      <ThemeProvider>
        <SetupWizard onComplete={() => window.location.reload()} />
        <Toaster position="top-right" richColors />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryProvider>
        <SearchProvider>
          <AgentTeamsDashboard />
        </SearchProvider>
      </QueryProvider>
      <Toaster position="top-right" richColors />
    </ThemeProvider>
  );
}
