import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { ConsumerQueue } from "../utils/queue";
import { sleep } from "../utils/sleep";

const execPromise = promisify(exec);

interface IDiskLimitItem {
  instance: Instance;
  workspace: string;
  maxSpace: number;
}

// du -s --block-size=1M /docker-volumes/app1-logs | cut -f1
class DiskLimitService {
  private readonly queue = new ConsumerQueue<IDiskLimitItem>(2048);
  private task: NodeJS.Timeout | null = null;
  private checking: boolean = false;
  private concurrent = 2;

  constructor() {
    this.task = setInterval(() => {
      this.#startCheck();
    }, 1000 * 10);
  }

  async checkInstanceDiskSize(instance: Instance) {
    const workspace = instance.absoluteCwdPath();
    const maxSpace = Number(instance.config.docker.maxSpace);
    this.queue.push({
      key: instance.instanceUuid,
      item: {
        instance,
        workspace,
        maxSpace
      }
    });
    this.#startCheck();
  }

  async #startCheck() {
    if (this.checking) return;
    this.checking = true;
    try {
      const promises = [];
      for (let i = 0; i < this.concurrent; i++) {
        const item = this.queue.pop();
        if (item) {
          promises.push(this.checkDiskNow(item));
        }
      }
      await Promise.all(promises);
    } finally {
      this.checking = false;
    }
  }

  async #stopInstance(instance: Instance) {
    if (instance.status() === Instance.STATUS_RUNNING) {
      const startCount = instance.startCount;
      instance.execPreset("stop");
      await sleep(1000 * 10);
      if (instance.status() !== Instance.STATUS_STOP && startCount === instance.startCount) {
        instance.println("ERROR", $t("TXT_CODE_8418e7fe"));
        instance
          .execPreset("kill")
          .then(() => {})
          .catch((err) => {});
      }
    }
  }

  /**
   * Get directory size in bytes with cross-platform support
   * Linux/Mac: uses du command
   * Windows: uses recursive calculation
   */
  async #getDirectorySizeBytes(dirPath: string): Promise<number> {
    const platform = process.platform;

    try {
      if (platform === "win32") {
        // Windows: use recursive calculation for better compatibility
        return await this.#getDirectorySizeRecursive(dirPath);
      } else {
        // Linux/Mac: use du command
        return await this.#getDirectorySizeUnix(dirPath);
      }
    } catch (error) {
      // Fallback: use recursive calculation if command fails
      try {
        return await this.#getDirectorySizeRecursive(dirPath);
      } catch (fallbackError) {
        return 0;
      }
    }
  }

  /**
   * Get directory size using du command (Unix/Linux/Mac)
   */
  async #getDirectorySizeUnix(dirPath: string): Promise<number> {
    const command = `du -s --block-size=1 "${dirPath}"`;
    const { stdout } = await execPromise(command);
    const sizeInBytes = Number(String(stdout.split(/\s+/)[0]).trim());
    return isNaN(sizeInBytes) ? 0 : sizeInBytes;
  }

  /**
   * Get directory size by recursively calculating file sizes
   * Works on all platforms, slower but more reliable
   */
  async #getDirectorySizeRecursive(dirPath: string): Promise<number> {
    let totalSize = 0;

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        try {
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            // Recursively calculate subdirectory size
            totalSize += await this.#getDirectorySizeRecursive(fullPath);
          } else if (entry.isFile()) {
            // Add file size
            const stat = await fs.promises.stat(fullPath);
            totalSize += stat.size;
          }
        } catch (entryError) {
          // Skip files/directories that can't be accessed (permission errors, etc.)
          continue;
        }
      }
    } catch (dirError) {
      // Return 0 if directory can't be read
      return 0;
    }

    return totalSize;
  }

  public async checkDiskNow(item: IDiskLimitItem, autoStop: boolean = true) {
    const { instance, workspace, maxSpace } = item;
    // There was already an initial check on the working directory when saving,
    // but we double-check here.
    if (['"', "'", "`", "$"].some((ch) => workspace.includes(ch)) || !fs.existsSync(workspace)) {
      instance.info.storageUsage = -1;
      instance.info.storageLimit = maxSpace;
      return;
    }

    let diskUsageSizeBytes = 0;
    try {
      diskUsageSizeBytes = await this.#getDirectorySizeBytes(workspace);
    } catch (error) {
      instance.println("WARNING", `Failed to get disk usage: ${error}`);
      instance.info.storageUsage = 0;
      instance.info.storageLimit = convertGBToBytes(maxSpace);
      return;
    }

    instance.info.storageUsage = diskUsageSizeBytes;
    instance.info.storageLimit = convertGBToBytes(maxSpace); // GB to bytes

    const storageLimit = instance.info.storageLimit;
    const storageUsage = instance.info.storageUsage;

    if (autoStop) {
      if (storageUsage >= storageLimit && storageLimit > 0) {
        for (let i = 0; i < 3; i++) {
          instance.println(
            "WARNING",
            $t("TXT_CODE_f94734d8", {
              storageLimit: convertBytesToGB(storageLimit),
              storageUsage: convertBytesToGB(storageUsage)
            })
          );
          instance.println("WARNING", $t("TXT_CODE_d448d98d"));
          await sleep(200);
        }
        this.#stopInstance(instance);
      }
    }

    return {
      isFull: storageUsage >= storageLimit && storageLimit > 0,
      storageLimit: convertBytesToGB(storageLimit),
      storageUsage: convertBytesToGB(storageUsage)
    };
  }
}

export function convertBytesToGB(bytes: number) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

export function convertGBToBytes(gb: number) {
  return Number((gb * 1024 * 1024 * 1024).toFixed(2));
}

export default new DiskLimitService();
