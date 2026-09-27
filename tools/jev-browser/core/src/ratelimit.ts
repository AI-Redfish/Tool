/**
 * 简单固定窗口速率限制（DESIGN §10：HTTP 服务"限定请求体/速率/并发"）。
 * 纯内存实现：单宿主进程内有效，不承诺跨进程。
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** 窗口内允许的最大请求数；<= 0 表示不限流。 */
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    // 防御性清理：键数量过多时丢弃全空条目
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
      }
    }
    return true;
  }
}
