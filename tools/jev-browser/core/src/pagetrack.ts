/** 轮询间隔默认值（毫秒）。 */
const DEFAULT_POLL_MS = 100;

/**
 * 在窗口内轮询「相对于 before 新出现的标签页」。
 *
 * 为什么必须轮询：浏览器处理 `target=_blank` 是**异步的**，新页出现晚于任务落定。
 * 实测「任务一结束就查一次」会稳定漏报——连续两次点击都确实开了新页，却一次都没报出来；
 * 而几秒后手动查看标签页列表就能看到。所以要在有限窗口内重试。
 *
 * `waitMs = 0` 时只查一次（调用方确定不会开新页时用，省掉这段等待）。
 * 泛型只要求 `pageId`，便于 CLI/MCP/API 各自传入自己的标签页结构。
 */
export async function pollNewPages<T extends { pageId: string }>(
  before: readonly T[],
  list: () => Promise<T[]>,
  opts: { waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const known = new Set(before.map((b) => b.pageId));
  const delta = (pages: T[]) => pages.filter((p) => !known.has(p.pageId));

  let opened = delta(await list());
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  while (opened.length === 0 && Date.now() < deadline) {
    await sleep(pollMs);
    opened = delta(await list());
  }
  return opened;
}
