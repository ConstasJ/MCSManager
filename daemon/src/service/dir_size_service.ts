import fs from "node:fs";
import path from "node:path";
import { getDirectorySize } from "../utils/dir_size";
import { ConsumerQueue, type IQueueItem } from "../utils/queue";
import InstanceSubsystem from "./system_instance";

interface ICacheItem {
	size: number;
	mtime: number;
	parent?: string;
	updatedAt: number;
}

class DirSizeService {
	private readonly queue = new ConsumerQueue<{ path: string }>(8192);
	private cache = new Map<string, ICacheItem>();
	private checking = false;
	private concurrent = 6; // Increased from 2 to 6 for faster parallel processing
	private ttl = 1000 * 60 * 5; // 5 minutes default
	private task: NodeJS.Timeout;
	private changeDetectTask: NodeJS.Timeout;
	private calculating = new Set<string>(); // Track paths being calculated
	private initialized = false;
	private initDelay = 1000 * 30; // 30 seconds after daemon starts
	private changeDetectDelay = 1000 * 30; // Detect mtime changes every 30 seconds

	constructor() {
		// Shorter interval (5s) for faster queue processing; interval is adjustable
		this.task = setInterval(() => this.startCheck(), 1000 * 5);
		// Schedule lazy initialization after daemon startup
		setTimeout(() => this.initialize(), this.initDelay);
		// Schedule periodic mtime change detection
		this.changeDetectTask = setInterval(
			() => this.detectChanges(),
			this.changeDetectDelay,
		);
	}

	/**
	 * Initialize by DFS scanning all instance directories
	 * Builds complete directory tree in cache with parent relationships
	 */
	private async initialize() {
		if (this.initialized) return;
		this.initialized = true;
		try {
			const instances = InstanceSubsystem.getInstances();
			for (const instance of instances) {
				try {
					const cwd = instance.absoluteCwdPath();
					if (cwd) {
						await this.dfsInitialize(cwd, undefined);
					}
				} catch {
					// ignore initialization errors for individual instances
				}
			}
		} catch {
			// ignore import or system errors
		}
	}

	/**
	 * Recursively scan directory tree from bottom-up with parallel sibling processing
	 * Cache all directories with size, mtime, and parent relationship
	 * Sibling directories are processed in parallel to maximize I/O and CPU utilization
	 */
	private async dfsInitialize(
		dirPath: string,
		parentPath: string | undefined,
	): Promise<number> {
		let totalSize = 0;
		let dirMtime = 0;

		try {
			const stat = await fs.promises.stat(dirPath);
			dirMtime = stat.mtime.getTime();

			const entries = await fs.promises.readdir(dirPath, {
				withFileTypes: true,
			});

			// Separate directories and files for parallel processing
			const subdirs: string[] = [];
			const files: string[] = [];

			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry.name);
				try {
					if (entry.isDirectory()) {
						subdirs.push(fullPath);
					} else if (entry.isFile()) {
						files.push(fullPath);
					}
				} catch {
					// ignore individual entry errors
					continue;
				}
			}

			// Process all sibling subdirectories in parallel
			if (subdirs.length > 0) {
				const subDirPromises = subdirs.map((subdir) =>
					this.dfsInitialize(subdir, dirPath).catch(() => 0),
				);
				const subDirSizes = await Promise.all(subDirPromises);
				totalSize += subDirSizes.reduce((a, b) => a + b, 0);
			}

			// Stat all sibling files in parallel
			if (files.length > 0) {
				const filePromises = files.map((file) =>
					fs.promises
						.stat(file)
						.then((s) => s.size)
						.catch(() => 0),
				);
				const fileSizes = await Promise.all(filePromises);
				totalSize += fileSizes.reduce((a, b) => a + b, 0);
			}
		} catch (err) {
			return 0;
		}

		// Cache this directory with parent relationship
		this.cache.set(dirPath, {
			size: totalSize,
			mtime: dirMtime,
			parent: parentPath,
			updatedAt: Date.now(),
		});

		return totalSize;
	}

	/**
	 * Periodically detect mtime changes and propagate size deltas
	 */
	private async detectChanges() {
		const toUpdate: Array<{ path: string; delta: number }> = [];

		for (const [dirPath, cached] of this.cache) {
			try {
				const stat = await fs.promises.stat(dirPath);
				const currentMtime = stat.mtime.getTime();

				if (currentMtime !== cached.mtime) {
					// mtime changed, recalculate this directory
					const newSize = await getDirectorySize(dirPath);
					const delta = newSize - cached.size;

					toUpdate.push({ path: dirPath, delta });

					// Update cache
					cached.size = newSize;
					cached.mtime = currentMtime;
					cached.updatedAt = Date.now();
				}
			} catch {
				// Directory no longer exists or inaccessible, skip
				continue;
			}
		}

		// Propagate deltas to parent directories
		for (const { path: dirPath, delta } of toUpdate) {
			if (delta !== 0) {
				this.propagateDelta(dirPath, delta);
			}
		}
	}

	/**
	 * Propagate size change delta up the directory tree
	 */
	private propagateDelta(dirPath: string, delta: number) {
		let current: string | undefined = dirPath;

		while (current) {
			const cached = this.cache.get(current);
			if (!cached) break;

			// Update parent directory size
			cached.size += delta;
			cached.updatedAt = Date.now();

			current = cached.parent;
		}
	}

	/**
	 * Check if path A is a parent of path B (or they are the same)
	 */
	private isAncestorOrSame(parentPath: string, childPath: string): boolean {
		const parent = path.normalize(parentPath);
		const child = path.normalize(childPath);
		if (parent === child) return true;
		// Check if child starts with parent + separator
		const sep = path.sep;
		return child.startsWith(parent + sep);
	}

	/**
	 * Check if we should skip this path due to parent/child relationships
	 */
	private shouldSkipPath(targetPath: string): boolean {
		// Skip if this exact path is already being calculated or cached
		if (this.calculating.has(targetPath) || this.cache.has(targetPath)) {
			return true;
		}
		// Skip if a parent directory is already being calculated
		for (const calculatingPath of this.calculating) {
			if (
				this.isAncestorOrSame(calculatingPath, targetPath) &&
				calculatingPath !== targetPath
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Enqueue a path for background calculation
	 * Only used for WRITE requests that need real-time updates
	 * READ requests should use getCached() directly
	 */
	public enqueue(path: string, isWriteRequest = false) {
		// Trigger lazy initialization on first enqueue
		if (!this.initialized) {
			this.initialize().catch(() => {});
		}

		// Only enqueue write requests; read requests use cache
		if (!isWriteRequest) return;

		// Skip if should not process this path
		if (this.shouldSkipPath(path)) return;
		const item: IQueueItem<{ path: string }> = { key: path, item: { path } };
		this.queue.push(item);
	}

	public getCached(path: string): number | undefined {
		const v = this.cache.get(path);
		if (!v) return undefined;
		if (Date.now() - v.updatedAt > this.ttl) return undefined;
		return v.size;
	}

	/**
	 * Get cached size with mtime validation
	 * Checks if mtime has changed since caching
	 */
	public async getCachedWithValidation(
		dirPath: string,
	): Promise<number | undefined> {
		const cached = this.cache.get(dirPath);
		if (!cached) return undefined;

		try {
			const stat = await fs.promises.stat(dirPath);
			const currentMtime = stat.mtime.getTime();

			// If mtime matches, cache is still valid
			if (currentMtime === cached.mtime) {
				return cached.size;
			}
		} catch {
			// Directory inaccessible
		}

		return undefined;
	}

	public async forceCalculate(path: string): Promise<number> {
		const size = await getDirectorySize(path);
		try {
			const stat = await fs.promises.stat(path);
			this.cache.set(path, {
				size,
				mtime: stat.mtime.getTime(),
				updatedAt: Date.now(),
			});
		} catch {
			this.cache.set(path, {
				size,
				mtime: 0,
				updatedAt: Date.now(),
			});
		}
		return size;
	}

	public stop() {
		if (this.task) clearInterval(this.task);
		if (this.changeDetectTask) clearInterval(this.changeDetectTask);
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
							this.calculating.add(item.path);
							try {
								const size = await getDirectorySize(item.path);
								try {
									const stat = await fs.promises.stat(item.path);
									this.cache.set(item.path, {
										size,
										mtime: stat.mtime.getTime(),
										updatedAt: Date.now(),
									});
								} catch {
									this.cache.set(item.path, {
										size,
										mtime: 0,
										updatedAt: Date.now(),
									});
								}
							} catch {
								// ignore calculation errors
							} finally {
								this.calculating.delete(item.path);
							}
						})(),
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
