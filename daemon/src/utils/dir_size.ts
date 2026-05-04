import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

const execPromise = promisify(exec);

export async function getDirectorySize(dirPath: string): Promise<number> {
  const platform = process.platform;
  // Try platform-optimized command first for non-Windows
  if (platform !== "win32") {
    try {
      const command = `du -s --block-size=1 "${dirPath}"`;
      const { stdout } = await execPromise(command);
      const size = Number(String(stdout.split(/\s+/)[0]).trim());
      if (!isNaN(size)) return size;
    } catch (err) {
      // fallthrough to recursive
    }
  }

  // Fallback: recursive calculation
  return await getDirectorySizeRecursive(dirPath);
}

export async function getDirectorySizeRecursive(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += await getDirectorySizeRecursive(full);
        } else if (entry.isFile()) {
          const st = await fs.promises.stat(full);
          total += st.size;
        }
      } catch (err) {
        // ignore entry error
        continue;
      }
    }
  } catch (err) {
    return 0;
  }
  return total;
}
