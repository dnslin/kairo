export interface ScrollerItemLike {
  sesUUID?: string;
  typeName?: string;
  name?: string;
  id?: string | number;
  [key: string]: unknown;
}

/**
 * 在 Vue 虚拟列表项集合中匹配指定会话
 */
export function findVueSessionItem<T extends ScrollerItemLike>(
  items: T[] | null | undefined,
  target: string
): { index: number; item: T | null } {
  if (!Array.isArray(items) || !target) return { index: -1, item: null };
  const idIndex = items.findIndex(
    item => item?.sesUUID === target || String(item?.id) === target
  );
  if (idIndex >= 0) {
    return { index: idIndex, item: items[idIndex] ?? null };
  }

  const nameMatches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.typeName === target || item?.name === target);
  if (nameMatches.length !== 1) return { index: -1, item: null };

  const match = nameMatches[0];
  return { index: match?.index ?? -1, item: match?.item ?? null };
}

/**
 * 嵌入在 CDP evaluate 脚本中的 Vue 虚拟滚动与会话检索 DOM 辅助函数
 */
export const VUE_SCROLLER_HELPERS_SCRIPT = `
  function getVueScrollerItems(selector) {
    const scroller = document.querySelector(selector || '.vue-recycle-scroller');
    if (scroller && scroller.__vue__ && Array.isArray(scroller.__vue__.items)) {
      return scroller.__vue__.items;
    }
    return null;
  }

  function findVueSessionItem(items, target) {
    if (!Array.isArray(items) || !target) return { index: -1, item: null };
    const idIndex = items.findIndex(function(item) {
      return item && (item.sesUUID === target || String(item.id) === target);
    });
    if (idIndex >= 0) return { index: idIndex, item: items[idIndex] };

    const nameMatches = items
      .map(function(item, index) { return { item: item, index: index }; })
      .filter(function(entry) {
        return entry.item && (entry.item.typeName === target || entry.item.name === target);
      });
    if (nameMatches.length !== 1) return { index: -1, item: null };
    return { index: nameMatches[0].index, item: nameMatches[0].item };
  }
`;
