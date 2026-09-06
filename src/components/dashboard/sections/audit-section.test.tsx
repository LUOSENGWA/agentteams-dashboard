import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/use-audit-events', () => ({
  useAuditEvents: vi.fn(),
}));

import { useAuditEvents, type AuditEventsResponse } from '@/hooks/use-audit-events';
import { AuditSection } from './audit-section';

const mockedUseAuditEvents = vi.mocked(useAuditEvents);

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('AuditSection', () => {
  it('renders an inline notice when the API returns 403 for an L1 caller', async () => {
    mockedUseAuditEvents.mockReturnValue({
      data: { success: false, error: '需要审计权限', observedLevel: 1, requiredLevel: 2 },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuditEvents>);
    render(<AuditSection />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByText('需要审计权限')).toBeInTheDocument();
    });
    expect(screen.getByText(/L1/)).toBeInTheDocument();
    expect(screen.getByText(/≥ L2/)).toBeInTheDocument();
  });

  it('points to dev-mode hint when the server received no identity header', async () => {
    mockedUseAuditEvents.mockReturnValue({
      data: { success: false, error: '需要审计权限', observedLevel: null, requiredLevel: 2 },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuditEvents>);
    render(<AuditSection />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByText('需要审计权限')).toBeInTheDocument();
    });
    expect(screen.getByText(/未收到身份头/)).toBeInTheDocument();
  });

  it('renders an empty state and explains the self-scope for an L2 auditor', async () => {
    mockedUseAuditEvents.mockReturnValue({
      data: { success: true, events: [], scope: 'self' } as AuditEventsResponse,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuditEvents>);
    render(<AuditSection />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByText('暂无审计事件')).toBeInTheDocument();
    });
    expect(screen.getByText(/限定为你本人执行/)).toBeInTheDocument();
  });

  it('renders audit events with actor, entity, action and severity', async () => {
    mockedUseAuditEvents.mockReturnValue({
      data: {
        success: true,
        events: [
          {
            id: 'audit-1',
            timestamp: Date.UTC(2026, 7, 25, 10, 0, 0),
            actor: 'alice',
            actor_level: 3,
            entity_type: 'worker',
            entity_name: 'w-1',
            action: 'create',
            severity: 'info',
            source_ip: '10.0.0.1',
          },
          {
            id: 'audit-2',
            timestamp: Date.UTC(2026, 7, 25, 11, 0, 0),
            actor: 'observer',
            actor_level: 1,
            entity_type: 'system',
            entity_name: 'audit-target',
            action: 'rbac.deny.delete',
            details: '权限等级 1 不允许 "delete" worker 操作',
            severity: 'warning',
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuditEvents>);
    render(<AuditSection />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
    expect(screen.getByText('拒绝：delete')).toBeInTheDocument();
    expect(screen.getByText('L3')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    // Entity badges render the raw type string; both rows should be present.
    expect(screen.getAllByText('worker').length).toBeGreaterThan(0);
    expect(screen.getAllByText('system').length).toBeGreaterThan(0);
  });
});