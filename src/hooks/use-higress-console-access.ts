import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/api-base';
import { useInfrastructure } from '@/hooks/use-agentteams-infrastructure';

interface SessionResponse {
  authenticated: boolean;
  /** 12.15：浏览器是否持有有效 Higress Console 会话（=管理登录路径）。 */
  higressSession?: boolean;
}

async function getConsoleSession(): Promise<SessionResponse> {
  const response = await fetch(apiUrl('/api/auth/session'), { credentials: 'same-origin' });
  if (!response.ok) return { authenticated: false };
  return response.json();
}

export function useHigressConsoleAccess() {
  const { data: infrastructure, isLoading: infrastructureLoading } = useInfrastructure();
  const session = useQuery({
    queryKey: ['higress-console-session'],
    queryFn: getConsoleSession,
    refetchInterval: 30_000,
    retry: false,
    throwOnError: false,
  });
  const consoleStatus = infrastructure?.higress?.console;
  // 12.15：门控改看「Higress 会话」而非 dashboard 会话——此前 luo 登录后
  // 仍发 /api/higress/* 请求拿 401（登录≠Console 会话）。
  const canManage = consoleStatus?.state === 'reachable' && session.data?.higressSession === true;

  let reason: string | undefined;
  if (consoleStatus?.state === 'unconfigured') {
    reason = '部署尚未配置 Higress Console 地址。';
  } else if (consoleStatus?.state === 'unreachable') {
    reason = 'Higress Console 当前不可访问。';
  } else if (!session.isLoading && !session.data?.authenticated) {
    reason = '未登录——请先登录后再使用模型管理。';
  } else if (!session.isLoading && session.data?.higressSession !== true) {
    reason =
      '模型网关管理需要 Higress Console 会话：请退出后用管理账号（admin）重新登录即可启用本页；聊天等其它功能不受影响（QwenPaw 插件的「模型」页亦可经管理员验证后管理）。';
  }

  return {
    canManage,
    isLoading: infrastructureLoading || session.isLoading,
    reason,
  };
}
