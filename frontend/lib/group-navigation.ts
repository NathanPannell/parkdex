const historyKey = "parkdexGroup";

type GroupNavigation = { groupId: string | null; scrollTop: number };

/** Private group IDs belong to this browser history entry, never the shareable URL. */
export function rememberGroupNavigation(groupId: string | null, scrollTop = 0, accountId: string | null = null): void {
  window.history.replaceState({
    ...window.history.state,
    [historyKey]: groupId && accountId ? { groupId, scrollTop: Math.max(0, scrollTop), accountId } : null,
  }, "");
}

export function readGroupNavigation(accountId: string | null = null): GroupNavigation {
  const saved = window.history.state?.[historyKey];
  if (!accountId || saved?.accountId !== accountId) return { groupId: null, scrollTop: 0 };
  return {
    groupId: typeof saved?.groupId === "string" ? saved.groupId : null,
    scrollTop: typeof saved?.scrollTop === "number" && Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
  };
}
