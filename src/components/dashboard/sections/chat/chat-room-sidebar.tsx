'use client';

import { useState } from 'react';
import { MessageSquare, PanelLeftClose, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { RoomListItem } from './room-list-item';
import { filterRooms, groupRoomsByType } from './room-builders';
import type { RoomInfo } from './room-info';

function shortUserId(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return userId.split(':')[0].slice(1);
}

export function ChatRoomSidebar({
  rooms,
  selectedRoomId,
  onSelectRoom,
  isLoggedIn,
  userId,
  isLoading,
  onCollapse,
}: {
  rooms: RoomInfo[];
  selectedRoomId: string | null;
  onSelectRoom: (_id: string) => void;
  isLoggedIn: boolean;
  userId: string | null;
  isLoading: boolean;
  onCollapse: () => void;
}) {
  const [filter, setFilter] = useState('');
  const filtered = filterRooms(rooms, filter);
  const groups = groupRoomsByType(filtered);
  const shortId = shortUserId(userId);

  return (
    <div className="w-56 shrink-0 flex flex-col border-r border-border bg-muted/20 overflow-hidden">
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold tracking-wide">会话</span>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">{filtered.length} 个房间</span>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={onCollapse}
              title="隐藏会话列表"
            >
              <PanelLeftClose className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="搜索房间..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 pl-7 text-xs bg-background/70 rounded-lg"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 custom-scrollbar">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))
        ) : filtered.length === 0 ? (
          <div className="text-center py-8">
            <MessageSquare className="w-8 h-8 text-muted-foreground mx-auto mb-2" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">暂无聊天房间</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              创建 Worker 或 Team 后会自动生成 Matrix 房间
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.type} className="mb-1.5">
              <p className="px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground">
                {group.label}
                <span className="ml-1 font-normal">{group.rooms.length}</span>
              </p>
              {group.rooms.map((room) => (
                <RoomListItem
                  key={room.id}
                  room={room}
                  isSelected={selectedRoomId === room.id}
                  onClick={() => onSelectRoom(room.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="p-3 border-t border-border shrink-0 bg-card/30">
        {isLoggedIn ? (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <p className="text-[10px] text-muted-foreground truncate">已登录: {shortId}</p>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <p className="text-[10px] text-muted-foreground">未登录 - 仅可查看房间列表</p>
          </div>
        )}
      </div>
    </div>
  );
}
