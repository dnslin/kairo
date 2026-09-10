/** 原生定时器只负责唤醒；每次醒来重新检查绝对时刻，避免超长延迟溢出。 */
export function scheduleDeadline(deadline: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const wake = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(wake, Math.min(remaining, 2_147_483_647));
  };
  wake();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
