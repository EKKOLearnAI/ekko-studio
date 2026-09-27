export interface SessionCategoryLike {
  id: number;
  name: string;
}

export interface SessionCategoryAssignment {
  categoryId?: number | null;
}

export interface RecentSessionAssignment extends SessionCategoryAssignment {
  id: string;
  updatedAt?: number | null;
}

export interface VisibleSessionCategoryGroup<T> {
  key: string;
  label: string;
  sessions: T[];
  /** Real category id; undefined for Uncategorized and Recent. */
  categoryId?: number;
}

export interface RecentSessionPartition<T> {
  group: VisibleSessionCategoryGroup<T>;
  remaining: T[];
}

export function buildVisibleSessionCategoryGroups<T extends SessionCategoryAssignment>(
  categories: readonly SessionCategoryLike[],
  sessions: readonly T[],
  uncategorizedLabel: string,
): VisibleSessionCategoryGroup<T>[] {
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  // Every category stays visible, even without chats, so its New Chat entry is reachable.
  const groups: VisibleSessionCategoryGroup<T>[] = categories.map((category) => ({
    key: `category-${category.id}`,
    label: category.name,
    sessions: sessions.filter((session) => session.categoryId === category.id),
    categoryId: category.id,
  }));
  const uncategorized = sessions.filter(
    (session) => session.categoryId == null || !knownCategoryIds.has(session.categoryId),
  );
  if (uncategorized.length > 0) {
    groups.push({
      key: "category-none",
      label: uncategorizedLabel,
      sessions: uncategorized,
    });
  }
  return groups;
}

export function buildRecentSessionCategoryGroup<T extends RecentSessionAssignment>(
  sessions: readonly T[],
  limit: number,
  label: string,
): VisibleSessionCategoryGroup<T> {
  return partitionRecentSessions(sessions, limit, label).group;
}

export function partitionRecentSessions<T extends RecentSessionAssignment>(
  sessions: readonly T[],
  limit: number,
  label: string,
): RecentSessionPartition<T> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 10)));
  const recent = [...sessions]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, safeLimit);
  return {
    group: {
      key: "recent",
      label,
      sessions: recent,
    },
    // “最近”是快捷入口，不从真实分类中移除对应会话。
    remaining: [...sessions],
  };
}
