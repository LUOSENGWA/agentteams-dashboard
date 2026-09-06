import type { ManagerResponse, TeamResponse, WorkerResponse } from '@/lib/agentteams-api';
import type { RoomInfo } from './room-info';

export interface RoomMetaInput {
  lastMessageTs?: number;
  lastMessagePreview?: string;
  unreadCount?: number;
  unreadHighlightCount?: number;
}

/** Lookup table for per-room meta. Keys are Matrix room ids. */
export type RoomMetaByRoomId = Record<string, RoomMetaInput>;

/**
 * Build the sidebar room list from agent/team/manager resources.
 *
 * Each room's lastMessageTs / unreadCount is filled in from the supplied
 * `metaByRoomId` (driven by /sync). Rooms with newer activity float to the
 * top of the sidebar naturally because ChatSection sorts after this returns.
 */
export function buildRooms(
  workers: WorkerResponse[] | undefined,
  teams: TeamResponse[] | undefined,
  managers: ManagerResponse[] | undefined,
  metaByRoomId?: RoomMetaByRoomId,
): RoomInfo[] {
  const lookup = metaByRoomId ?? {};
  const enrich = (
    rid: string,
  ): Pick<RoomInfo, 'lastMessageTs' | 'lastMessagePreview' | 'unreadCount' | 'unreadHighlightCount'> => {
    const m = lookup[rid];
    if (!m) return {};
    return {
      lastMessageTs: m.lastMessageTs,
      lastMessagePreview: m.lastMessagePreview,
      unreadCount: m.unreadCount,
      unreadHighlightCount: m.unreadHighlightCount,
    };
  };

  const roomList: RoomInfo[] = [];
  teams?.forEach((team) => {
    if (team.teamRoomID) {
      roomList.push({
        id: team.teamRoomID,
        name: `${team.name} 团队房间`,
        type: 'team',
        members: team.workerNames || [],
        parentTeam: team.name,
        phase: team.phase,
        team,
        ...enrich(team.teamRoomID),
      });
    }
  });
  workers?.forEach((worker) => {
    if (worker.roomID) {
      roomList.push({
        id: worker.roomID,
        name: `${worker.name} 房间`,
        type: 'worker',
        members: [worker.matrixUserID].filter(Boolean),
        parentTeam: worker.team,
        matrixUserId: worker.matrixUserID,
        workerName: worker.name,
        phase: worker.phase,
        runtime: worker.runtime,
        ...enrich(worker.roomID),
      });
    }
  });
  managers?.forEach((manager) => {
    // Prefer the DM room for human-manager interaction; fall back to manager's own room
    const chatRoomId = manager.leaderDMRoomID || manager.roomID;
    if (chatRoomId) {
      // Find the team this manager leads
      const leadingTeam = teams?.find((t) => t.leaderName === manager.name);
      roomList.push({
        id: chatRoomId,
        name: `${manager.name} 对话`,
        type: 'manager',
        members: [manager.matrixUserID].filter(Boolean),
        matrixUserId: manager.matrixUserID,
        parentTeam: leadingTeam?.name,
        phase: manager.phase,
        ...enrich(chatRoomId),
      });
    }
  });
  return roomList;
}

export function filterRooms(rooms: RoomInfo[], filter: string): RoomInfo[] {
  if (!filter) return rooms;
  const q = filter.toLowerCase();
  return rooms.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      r.members.some((m) => m && m.toLowerCase().includes(q)),
  );
}

/**
 * Sort rooms by latest activity (newest message first), then alphabetically.
 * Rooms without a last-message timestamp fall to the tail. Unread state and
 * @mention highlights do NOT influence the order — they are rendered as badges
 * so clearing an unread room never makes it jump in the list.
 */
export function sortRoomsByRecency(rooms: RoomInfo[]): RoomInfo[] {
  return [...rooms].sort((a, b) => {
    const ta = a.lastMessageTs;
    const tb = b.lastMessageTs;
    if (ta !== undefined && tb !== undefined) {
      if (ta !== tb) return tb - ta;
    } else if (ta !== undefined) {
      return -1; // a has a timestamp, b doesn't → a first
    } else if (tb !== undefined) {
      return 1; // b has a timestamp, a doesn't → b first
    }
    return a.name.localeCompare(b.name);
  });
}

export const ROOM_TYPE_ORDER: RoomInfo['type'][] = ['team', 'worker', 'manager', 'human', 'unknown'];

export const ROOM_TYPE_LABELS: Record<RoomInfo['type'], string> = {
  team: '团队',
  worker: 'Agent',
  manager: 'Manager',
  human: 'Human',
  unknown: '其他',
};

export interface RoomTypeGroup {
  type: RoomInfo['type'];
  label: string;
  rooms: RoomInfo[];
}

/** Group rooms by type while keeping recency order inside each group. */
export function groupRoomsByType(rooms: RoomInfo[]): RoomTypeGroup[] {
  const buckets = new Map<RoomInfo['type'], RoomInfo[]>();
  for (const room of rooms) {
    const list = buckets.get(room.type);
    if (list) list.push(room);
    else buckets.set(room.type, [room]);
  }
  return ROOM_TYPE_ORDER.filter((type) => (buckets.get(type)?.length ?? 0) > 0).map((type) => ({
    type,
    label: ROOM_TYPE_LABELS[type],
    rooms: buckets.get(type) ?? [],
  }));
}

const PREVIEW_MAX = 72;

/** Flatten a Matrix event body into a one-line sidebar preview. */
export function extractMessagePreview(event: {
  type?: string;
  content?: { body?: unknown; msgtype?: string };
}): string | undefined {
  if (event.type && event.type !== 'm.room.message') return undefined;
  const content = event.content;
  if (!content) return undefined;
  if (content.msgtype === 'm.image') return '[图片]';
  if (content.msgtype === 'm.file') return '[文件]';
  if (content.msgtype === 'm.audio') return '[音频]';
  if (content.msgtype === 'm.video') return '[视频]';
  const body = content.body;
  if (typeof body !== 'string') return undefined;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}
