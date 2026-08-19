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
  const index = items.findIndex(it => {
    if (!it) return false;
    return (
      it.sesUUID === target ||
      it.typeName === target ||
      it.name === target ||
      String(it.id) === target ||
      (typeof it.typeName === 'string' && it.typeName.includes(target))
    );
  });
  return {
    index,
    item: index >= 0 ? (items[index] ?? null) : null,
  };
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
    const index = items.findIndex(function(it) {
      if (!it) return false;
      return (
        it.sesUUID === target ||
        it.typeName === target ||
        it.name === target ||
        String(it.id) === target ||
        (typeof it.typeName === 'string' && it.typeName.includes(target))
      );
    });
    return {
      index: index,
      item: index >= 0 ? items[index] : null
    };
  }
`;
