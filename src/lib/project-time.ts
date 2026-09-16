// 项目时间戳（时间排序共用）——9/16 从 artifacts-section 抽出，projects
// section 拓扑视图排序复用，单源不再复制。
//
// 插件 projectActivityTs 同款多源兜底：上游 ListProjects 的 projectSummary
// 可能无时间戳字段（v1.2.3 实测全无 created_at/updated_at——插件注释实锤），
// 此时用 project_id 内嵌日期近似（YYYYMMDD 段），时间排序不空转。
// （插件第三源=项目房间 last_ts，依赖 Matrix 房间缓存，dashboard 不持有。）
export function projectTs(p: {
  project_id?: string;
  created_at?: string | number;
  updated_at?: string | number;
}): number {
  const raw = p.updated_at ?? p.created_at;
  let best = 0;
  if (typeof raw === 'string') best = Date.parse(raw) || 0;
  else if (typeof raw === 'number') best = raw;
  const m = String(p.project_id || '').match(/(20\d{6})/);
  if (m) {
    const approx = new Date(
      Number(m[1].slice(0, 4)),
      Number(m[1].slice(4, 6)) - 1,
      Number(m[1].slice(6, 8)),
    ).getTime();
    if (approx > best) best = approx;
  }
  return best;
}
