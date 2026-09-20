'use client';

import { useSyncExternalStore, useState } from 'react';
import { MessageSquare, PanelLeftClose, Search } from 'lucide-react';

/** Element-style resizable room list: drag the right edge to change width. */
const SIDEBAR_DEFAULT_W = 224;
const SIDEBAR_MIN_W = 176;
const SIDEBAR_MAX_W = 448;
const SIDEBAR_W_KEY = 'agentteams.chatSidebarWidth';

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_W;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_W_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, n));
  } catch {
    /* storage unavailable — fall through to default */
  }
  return SIDEBAR_DEFAULT_W;
}

// Module-level persisted-width store (useSyncExternalStore): the width
// hydrates from localStorage WITHOUT an effect setState (no cascading
// render), and SSR gets the default via the server snapshot.
let sidebarWidthCache: number | null = null;
const sidebarWidthListeners = new Set<() => void>();

function readSidebarWidthStore(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_W;
  if (sidebarWidthCache === null) sidebarWidthCache = loadSidebarWidth();
  return sidebarWidthCache;
}

const subscribeSidebarWidth = (cb: () => void): (() => void) => {
  sidebarWidthListeners.add(cb);
  return () => {
    sidebarWidthListeners.delete(cb);
  };
};

/** Live width update (drag) — no persistence until the pointer is up. */
function publishSidebarWidth(w: number): void {
  sidebarWidthCache = w;
  sidebarWidthListeners.forEach((l) => l());
}

function persistSidebarWidth(w: number): void {
  sidebarWidthCache = w;
  try {
    window.localStorage.setItem(SIDEBAR_W_KEY, String(w));
  } catch {
    /* non-persistent environment — width still applied for this session */
  }
}
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { RoomListItem } from './room-list-item';
import { filterRooms, groupRoomsByType, sortRoomsByRecency } from './room-builders';
import type { RoomInfo } from './room-info';

const SORT_KEY = 'chat-sidebar-sort';

// 12.15：排序模式持久化走 useSyncExternalStore（SSR 首个客户端渲染用 server
// 快照 'time'，随后切到持久化值——规避 react-hooks/set-state-in-effect，
// 与页面既有宽度存储同思路）。
type SortMode = 'time' | 'type';
function readSortStore(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === 'type' ? 'type' : 'time';
  } catch {
    return 'time';
  }
}
const sortListeners = new Set<() => void>();
function subscribeSort(fn: () => void): () => void {
  sortListeners.add(fn);
  return () => {
    sortListeners.delete(fn);
  };
}
function publishSort(m: SortMode) {
  try {
    localStorage.setItem(SORT_KEY, m);
  } catch {
    /* storage 不可用忽略 */
  }
  sortListeners.forEach((fn) => fn());
}

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
  // 12.15（装验反馈「加上像插件那样的分类」）：全部/群组/私聊——群组=成员>2
  // （plugin 同款口径）；与排序模式正交。
  const [kindFilter, setKindFilter] = useState<'all' | 'group' | 'dm'>('all');
  const filtered = filterRooms(rooms, filter);
  const visible =
    kindFilter === 'all'
      ? filtered
      : filtered.filter((r) =>
          kindFilter === 'group'
            ? (r.memberCount ?? 0) > 2
            : (r.memberCount ?? 0) <= 2,
        );
  const groups = groupRoomsByType(visible);
  // 12.15（装验反馈「项目群被丢进『其他』、要和 Element/插件一样排序」）：
  // 默认「按时间」=Element/插件同款的单一时间序混合列表；「按类型」保留
  // 分组视图（团队/Agent/Manager/房间）。
  const sortMode = useSyncExternalStore(subscribeSort, readSortStore, () => 'time' as const);
  const changeSort = publishSort;
  const timeOrdered = sortRoomsByRecency(visible);
  const shortId = shortUserId(userId);

  // Resizable width (persisted) via the module store above — SSR and the
  // first client paint agree on the default; the persisted width applies
  // from the first client render (store snapshot), no mount-time setState.
  const width = useSyncExternalStore(
    subscribeSidebarWidth,
    readSidebarWidthStore,
    () => SIDEBAR_DEFAULT_W,
  );
  const [isResizing, setIsResizing] = useState(false);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = readSidebarWidthStore();
    setIsResizing(true);
    const onMove = (ev: PointerEvent) => {
      publishSidebarWidth(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setIsResizing(false);
      persistSidebarWidth(readSidebarWidthStore());
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={`relative shrink-0 flex flex-col border-r border-border bg-muted/20 overflow-hidden ${isResizing ? 'select-none' : ''}`}
      style={{ width }}
    >
      {/* Drag handle: right edge, Element-style col-resize */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话列表宽度"
        aria-valuemin={SIDEBAR_MIN_W}
        aria-valuemax={SIDEBAR_MAX_W}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = event.shiftKey ? 32 : 8;
          // Sidebar sits on the left: ArrowRight widens it, ArrowLeft narrows.
          const delta = event.key === 'ArrowRight' ? step : -step;
          const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, Math.round(width) + delta));
          publishSidebarWidth(next);
          persistSidebarWidth(next);
        }}
        className={`absolute top-0 right-[-2px] w-1 h-full cursor-col-resize z-10 transition-colors focus:bg-primary/60 focus:outline-none ${isResizing ? 'bg-primary/60' : 'bg-transparent hover:bg-primary/40'}`}
      />
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold tracking-wide">会话</span>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">{visible.length} 个房间</span>
            <div className="flex items-center rounded border border-border p-0.5" role="group" aria-label="房间分类">
              {(['all', 'group', 'dm'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`rounded px-1.5 py-0.5 text-[10px] ${kindFilter === k ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setKindFilter(k)}
                  title={k === 'all' ? '全部房间' : k === 'group' ? '群组（成员 > 2）' : '私聊（成员 ≤ 2）'}
                >
                  {k === 'all' ? '全部' : k === 'group' ? '群组' : '私聊'}
                </button>
              ))}
            </div>
            <div className="flex items-center rounded border border-border p-0.5" role="group" aria-label="房间排序">
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] ${sortMode === 'time' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => changeSort('time')}
                title="按最近消息时间排序（Element/插件同款）"
              >
                时间
              </button>
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] ${sortMode === 'type' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => changeSort('type')}
                title="按房间类型分组（团队/Agent/Manager/房间）"
              >
                类型
              </button>
            </div>
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
          sortMode === 'time'
            ? timeOrdered.map((room) => (
                <RoomListItem
                  key={room.id}
                  room={room}
                  isSelected={selectedRoomId === room.id}
                  onClick={() => onSelectRoom(room.id)}
                />
              ))
            : groups.map((group) => (
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
