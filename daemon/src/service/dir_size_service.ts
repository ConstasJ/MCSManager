import { getDirectorySize } from "../utils/dir_size";
import { ConsumerQueue } from "../utils/queue";

interface IQueueItem {
  path: string;
}

interface ICacheItem {
  size: number;
  updatedAt: number;
}

class DirSizeService {
  private readonly queue = new ConsumerQueue<IQueueItem>(8192);
  private cache = new Map<string, ICacheItem>();
  private checking = false;
  private concurrent = 2;
  private task: NodeJS.Timeout | null = null;
  private ttl = 1000 * 60 * 5; // 5 minutes default

  constructor() {
    this.task = setInterval(() => this.startCheck(), 1000 * 10);
  }

  public enqueue(path: string) {
    this.queue.push({ key: path, item: { path } } as any);
  }

  public getCached(path: string): number | undefined {
    const v = this.cache.get(path);
    if (!v) return undefined;
    if (Date.now() - v.updatedAt > this.ttl) return undefined;
    return v.size;
  }

  public async forceCalculate(path: string): Promise<number> {
    const size = await getDirectorySize(path);
    this.cache.set(path, { size, updatedAt: Date.now() });
    return size;
  }

  private async startCheck() {
    if (this.checking) return;
    this.checking = true;
    try {
      const promises: Promise<void>[] = [];
      for (let i = 0; i < this.concurrent; i++) {
        const item = this.queue.pop();
        if (item) {
          promises.push(
            (async () => {
              try {
                const size = await getDirectorySize(item.path);
                this.cache.set(item.path, { size, updatedAt: Date.now() });
              } catch (err) {
                // ignore
              }
            })()
          );
        }
      }
      await Promise.all(promises);
    } finally {
      this.checking = false;
    }
  }
}

export default new DirSizeService();
