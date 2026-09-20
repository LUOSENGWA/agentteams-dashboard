'use client';

import { Bell, Check, Trash2, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useNotificationStore } from '@/lib/notification-store';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

const typeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const typeColors: Record<string, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-cyan-500',
};

export function NotificationPopover() {
  const { notifications, markAsRead, markAllRead, clearAll, unreadCount } =
    useNotificationStore();
  const count = unreadCount();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 relative" aria-label={`通知（${count} 条未读）`}>
          <Bell className="w-4 h-4" aria-hidden="true" />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between p-3 border-b">
          <span className="font-medium text-sm">通知</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={markAllRead}>
              <Check className="w-3 h-3 mr-1" />
              全部已读
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAll}>
              <Trash2 className="w-3 h-3 mr-1" />
              清空
            </Button>
          </div>
        </div>
        {/* Native overflow scroll: Radix ScrollArea's focusable viewport
            paints a ring that gets clipped into stray edge stripes. */}
        <div className="max-h-96 overflow-y-auto custom-scrollbar">
          {notifications.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              暂无通知
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((n) => {
                const TypeIcon = typeIcons[n.type] || Info;
                const typeColor = typeColors[n.type] || 'text-muted-foreground';
                return (
                  <div
                    key={n.id}
                    className={`p-3 text-sm cursor-pointer hover:bg-accent transition-colors ${
                      !n.read ? 'border-l-2 border-l-primary bg-primary/[0.04]' : ''
                    }`}
                    onClick={() => markAsRead(n.id)}
                  >
                    <div className="flex items-start gap-2">
                      <TypeIcon className={`w-4 h-4 ${typeColor} mt-0.5 shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`font-medium ${!n.read ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {n.title}
                          </p>
                          <Badge
                            variant={
                              n.type === 'success' ? 'default' :
                              n.type === 'error' ? 'destructive' :
                              n.type === 'warning' ? 'secondary' :
                              'outline'
                            }
                            className="text-[10px] shrink-0"
                          >
                            {n.type === 'success' ? '成功' :
                             n.type === 'error' ? '错误' :
                             n.type === 'warning' ? '警告' : '信息'}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {n.message}
                        </p>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 ml-6">
                      {formatDistanceToNow(n.timestamp, { addSuffix: true, locale: zhCN })}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
