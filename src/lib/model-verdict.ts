/**
 * model 字段写前校验（对齐插件 G2 纪律，9/13 罗总验收反馈「创建 worker 参考插件」）。
 *
 * 纯函数——WorkerCreateDialog 与建队内联新建 Worker 共用，同一套候选与
 * 判定，行为零分叉。候选 = 网关 alias 组（configured ∪ builtin 16）；
 * SGLang 在服层归 F4 独立 PR（冻结中），此处不引入。
 *
 * 9/2「/models 事故」硬规则：路径/URL/含空格形态不可能是模型名，
 * 候选列表自身被污染时也必须拦得住（恒生效，不依赖候选可用）。
 */

export interface ModelVerdict {
  level: 'ok' | 'warn' | 'error';
  /** warn 细分：list=未命中候选；nocands=候选列表不可用（未校验）。 */
  reason?: 'list' | 'nocands';
}

/** 路径/URL/带空格形态 = 模型名不可能是的（恒生效硬规则）。 */
export function isPathLikeModel(v: string): boolean {
  const value = (v || '').trim();
  return value.startsWith('/') || value.includes('://') || /\s/.test(value);
}

/** model 字段写前校验。留空 = 显式「跟随集群默认」（ok，不写 model 字段）。 */
export function validateModelValue(raw: string, candidates: string[]): ModelVerdict {
  const value = (raw || '').trim();
  if (!value) return { level: 'ok' };
  if (isPathLikeModel(value)) return { level: 'error' };
  if (candidates.length === 0) return { level: 'warn', reason: 'nocands' };
  if (!candidates.includes(value)) return { level: 'warn', reason: 'list' };
  return { level: 'ok' };
}

/** 判定文案（与插件 modelVerdictText 同构，适配 alias 层措辞）。 */
export function modelVerdictText(v: ModelVerdict, value: string, candidates: string[]): string {
  if (v.level === 'error') {
    return '模型名不能是路径/URL 或含空格（如 /models——9/2 事故值）';
  }
  if (v.level === 'warn' && v.reason === 'list') {
    const list = `${candidates.slice(0, 8).join(', ')}${candidates.length > 8 ? '…' : ''}`;
    return `未命中 alias 组（可用：${list}）——将按原样写入，需网关路由支持`;
  }
  if (v.level === 'warn' && v.reason === 'nocands') {
    return 'alias 列表不可用：未校验，创建后须人工确认路由';
  }
  if (!(value || '').trim()) {
    return '留空 = 跟随集群默认';
  }
  return '命中 alias 组';
}
