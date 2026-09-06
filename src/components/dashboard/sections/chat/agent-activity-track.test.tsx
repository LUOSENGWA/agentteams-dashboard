import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentActivityTrack } from './agent-activity-track';
import { useTaskStore } from '@/lib/task-store';
import { useHitlInboxStore } from '@/lib/hitl-inbox';

afterEach(() => {
  cleanup();
  useTaskStore.getState().clearTasks();
  useHitlInboxStore.getState().clearConfirmations();
});

describe('AgentActivityTrack', () => {
  it('renders nothing when the room has no task or HITL item', () => {
    const { container } = render(<AgentActivityTrack roomId="!room:test" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the active task title and step progress', () => {
    useTaskStore.getState().upsertTask({
      runId: 'run-1',
      title: '巡检日志',
      status: 'running',
      roomId: '!room:test',
      senderMatrixUserId: '@mgr:test',
      subagents: [],
      steps: [
        { title: 'a', status: 'done' },
        { title: 'b', status: 'running' },
      ],
    });
    render(<AgentActivityTrack roomId="!room:test" />);
    expect(screen.getByText('巡检日志 · 1/2')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('prefers a pending HITL confirmation over the task', () => {
    useTaskStore.getState().upsertTask({
      runId: 'run-1',
      title: '巡检日志',
      status: 'running',
      roomId: '!room:test',
      senderMatrixUserId: '@mgr:test',
      subagents: [],
      steps: [],
    });
    useHitlInboxStore.getState().upsertConfirmation({
      id: 'c1',
      roomId: '!room:test',
      eventId: '$e1',
      sender: '@agent:test',
      toolName: 'shell',
      triggeredBy: 'worker-a',
      approveReply: '/approve',
      rejectReply: '拒绝',
      timestamp: Date.now(),
    });
    render(<AgentActivityTrack roomId="!room:test" />);
    expect(screen.getByText(/待确认 shell/)).toBeInTheDocument();
    expect(screen.getByText('HITL')).toBeInTheDocument();
    expect(screen.queryByText('巡检日志')).toBeNull();
  });
});
