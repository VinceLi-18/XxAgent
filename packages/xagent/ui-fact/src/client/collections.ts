const RETAINED_ROWS = 200

/** Keep first-seen server order while bounding one in-memory collection.
 * @param items Server-ordered rows that may repeat an identity.
 * @returns At most 200 rows in first-seen order.
 */
export function mergeFactRows<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>()
  return items.filter(item => !seen.has(item.id) && seen.add(item.id)).slice(0, RETAINED_ROWS)
}

/** Verify every server row belongs to the active Project.
 * @param items Rows returned by one Remote page.
 * @param projectId Active Project identity.
 * @returns Whether every row belongs to the active Project.
 */
export function rowsMatchProject(items: readonly { readonly projectId: string }[], projectId: string): boolean {
  return items.every(item => item.projectId === projectId)
}
