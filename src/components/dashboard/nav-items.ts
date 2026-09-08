import {
  LayoutDashboard,
  Bot,
  Users,
  Crown,
  UserCheck,
  MessageSquare,
  BookOpen,
  Brain,
  Sparkles,
  ListTodo,
  GitBranch,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { useAgentTeamsStore } from '@/lib/agentteams-store';

export const STORAGE_KEY = 'agentteams-active-section';

export type DeploymentMode = 'embedded' | 'k8s';

export type NavGroup = 'core' | 'runtime' | 'resource' | 'footer';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Visible in these modes only. Omit = visible everywhere. */
  modes?: DeploymentMode[];
  /** When true, the item is hidden if the matching feature flag is off. */
  hiddenByFlag?: 'taskBoard' | 'projects';
  /** Experimental feature — sidebar shows a small "Beta" pill on the label. */
  isBeta?: boolean;
  /**
   * Minimum dashboard rbac level required to see this item (M19).
   * 3 = Admin/L1 only. UI convenience gate; the Controller enforces the
   * real boundary.
   */
  minLevel?: 1 | 2 | 3;
}

export const navItems: NavItem[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard, group: 'core' },
  { id: 'chat', label: '聊天', icon: MessageSquare, group: 'core' },
  // 运行时分组
  { id: 'tasks', label: '任务看板', icon: ListTodo, group: 'runtime', hiddenByFlag: 'taskBoard', isBeta: true },
  { id: 'projects', label: '项目', icon: GitBranch, group: 'runtime', hiddenByFlag: 'projects', isBeta: true },
  { id: 'workers', label: 'Workers', icon: Bot, group: 'runtime' },
  // L1-only (minLevel 3): the Controller's A2 chain 403s L2 (Matrix token)
  // reads on managers, and the humans list exposes sensitive fields
  // (initialPassword) that must not be visible to team-level users.
  { id: 'managers', label: 'Managers', icon: Crown, group: 'runtime', minLevel: 3 },
  { id: 'teams', label: '团队', icon: Users, group: 'runtime' },
  { id: 'humans', label: 'Humans', icon: UserCheck, group: 'runtime', minLevel: 3 },
  // 资源中心分组
  { id: 'skills', label: '市场', icon: Sparkles, group: 'resource' },
  { id: 'models', label: '模型', icon: Brain, group: 'resource' },
  { id: 'audit', label: '审计', icon: ScrollText, group: 'resource' },
  { id: 'docs', label: '文档', icon: BookOpen, group: 'footer' },
];

export const navGroups: { id: NavGroup; label: string }[] = [
  { id: 'core', label: '基础' },
  { id: 'runtime', label: '运行时' },
  { id: 'resource', label: '资源中心' },
  { id: 'footer', label: '' },
];

export function isNavItemVisible(
  item: NavItem,
  mode: DeploymentMode | null | undefined,
  taskBoardVisible?: boolean,
  projectsVisible?: boolean,
  userLevel?: number
): boolean {
  // UI level gate (M19): admin-only sections for L2 users. Convenience
  // layer only — the Controller (A2) enforces the real boundary.
  if (item.minLevel && (userLevel ?? 3) < item.minLevel) return false;
  if (item.hiddenByFlag === 'taskBoard') {
    // Prefer the caller-provided value (reactive); fall back to the live
    // zustand store for non-React call sites.
    const visible = taskBoardVisible ?? useAgentTeamsStore.getState().taskBoardVisible;
    if (!visible) return false;
  }
  if (item.hiddenByFlag === 'projects') {
    const visible = projectsVisible ?? useAgentTeamsStore.getState().projectsVisible;
    if (!visible) return false;
  }
  if (!item.modes) return true;
  if (!mode) return true;
  return item.modes.includes(mode);
}

export interface CreateAction {
  id: string;
  label: string;
  icon: LucideIcon;
  section: string;
  group?: NavGroup;
  modes?: DeploymentMode[];
  hiddenByFlag?: 'taskBoard' | 'projects';
  /** Minimum dashboard rbac level required (M19), same as NavItem. */
  minLevel?: 1 | 2 | 3;
}

export const createActions: readonly CreateAction[] = [
  { id: 'create-worker', label: '创建 Worker', icon: Bot, section: 'workers', group: 'runtime' },
  { id: 'create-team', label: '创建团队', icon: Users, section: 'teams', group: 'runtime' },
  { id: 'create-human', label: '创建 Human', icon: UserCheck, section: 'humans', group: 'runtime', minLevel: 3 },
  { id: 'open-chat', label: '打开聊天', icon: MessageSquare, section: 'chat', group: 'core' },
] as const;

export function isCreateActionVisible(
  action: CreateAction,
  mode: DeploymentMode | null | undefined,
  taskBoardVisible?: boolean,
  projectsVisible?: boolean,
  userLevel?: number
): boolean {
  if (action.minLevel && (userLevel ?? 3) < action.minLevel) return false;
  if (action.hiddenByFlag === 'taskBoard') {
    const visible = taskBoardVisible ?? useAgentTeamsStore.getState().taskBoardVisible;
    if (!visible) return false;
  }
  if (action.hiddenByFlag === 'projects') {
    const visible = projectsVisible ?? useAgentTeamsStore.getState().projectsVisible;
    if (!visible) return false;
  }
  if (!action.modes) return true;
  if (!mode) return true;
  return action.modes.includes(mode);
}
