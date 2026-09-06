import type { TeamResponse } from '@/lib/agentteams-api';

export interface RoomInfo {
  id: string;
  name: string;
  type: 'worker' | 'team' | 'manager' | 'human' | 'unknown';
  members: string[];
  parentTeam?: string;
  matrixUserId?: string;
  phase?: string;
  /** Worker runtime (worker rooms only). */
  runtime?: string;
  /** AgentTeams worker resource name owning this room (worker rooms). */
  workerName?: string;
  /** Full AgentTeams team resource behind a team room (drives the header detail). */
  team?: TeamResponse;
  /** Latest message timestamp in this room (epoch ms). Drives sidebar sort. */
  lastMessageTs?: number;
  /** Latest message preview shown under the room name. */
  lastMessagePreview?: string;
  /** Unread message count (from /sync unread_notifications). */
  unreadCount?: number;
  /** Unread count of @mentions / highlighted messages. */
  unreadHighlightCount?: number;
}
