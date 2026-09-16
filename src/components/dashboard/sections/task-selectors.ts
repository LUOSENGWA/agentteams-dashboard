// 任务看板纯选择器（tasks-section 的可测逻辑）。

/**
 * A persisted project selection is stale when it is an explicit (non-null)
 * id that no longer exists on the board — the project was deleted or
 * renamed after the user selected it. Callers should clear the stored
 * value in that case; otherwise the fallback to the first project
 * re-flashes on every reload and the stale id keeps getting re-persisted.
 *
 * Returns false while the board is still loading (empty project list) so a
 * valid stored selection is never clobbered before data arrives, and for
 * the null "no explicit selection" state (nothing is persisted — the board
 * auto-shows the first project by design).
 */
export function isStaleProjectSelection(
  selectedProjectId: string | null,
  projectRunIds: string[],
): boolean {
  if (selectedProjectId === null) return false;
  if (projectRunIds.length === 0) return false;
  return !projectRunIds.includes(selectedProjectId);
}
