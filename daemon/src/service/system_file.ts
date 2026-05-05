import fs from "fs-extra";
import iconv from "iconv-lite";
import { ProcessWrapper } from "mcsmanager-common";
import os from "os";
import path from "path";
import { compress, decompress } from "../common/compress";
import { globalConfiguration } from "../entity/config";
import { $t, i18next } from "../i18n";
import dirSizeService from "../service/dir_size_service";
import { normalizedJoin } from "../tools/filepath";

const ERROR_MSG_01 = $t("TXT_CODE_system_file.illegalAccess");
const MAX_EDIT_SIZE = 1024 * 1024 * 5;

interface IFile {
	name: string;
	size: number;
	time: string;
	type: number;
	mode: number;
}

export default class FileManager {
	public cwd: string = ".";

	constructor(
		public topPath: string = "",
		public fileCode?: string,
	) {
		if (!path.isAbsolute(topPath)) {
			this.topPath = path.normalize(path.join(process.cwd(), topPath));
		} else {
			this.topPath = path.normalize(topPath);
		}
		if (!fileCode) {
			this.fileCode = "utf-8";
			if (i18next.language == "zh_cn") this.fileCode = "gbk";
		}
	}

	isRootTopRath() {
		return this.topPath === "/" || this.topPath === "\\";
	}

	toAbsolutePath(fileName: string = "") {
		const topAbsolutePath = this.topPath;

		if (path.normalize(fileName).indexOf(topAbsolutePath) === 0)
			return fileName;

		let finalPath = "";
		if (os.platform() === "win32") {
			const reg = new RegExp("^[A-Za-z]{1}:[\\\\/]{1}");
			if (reg.test(this.cwd)) {
				finalPath = path.normalize(path.join(this.cwd, fileName));
			} else if (reg.test(fileName)) {
				finalPath = path.normalize(fileName);
			}
		}

		if (!finalPath) {
			finalPath = path.normalize(path.join(this.topPath, this.cwd, fileName));
		}

		if (
			finalPath.indexOf(topAbsolutePath) !== 0 &&
			topAbsolutePath !== "/" &&
			topAbsolutePath !== "\\"
		)
			throw new Error(ERROR_MSG_01);
		return finalPath;
	}

	checkPath(fileNameOrPath: string) {
		if (this.isRootTopRath()) return true;
		const destAbsolutePath = path.normalize(
			this.toAbsolutePath(fileNameOrPath),
		);
		const topAbsolutePath = path.normalize(this.topPath);

		const destPath = destAbsolutePath.endsWith(path.sep)
			? destAbsolutePath.slice(0, -1)
			: destAbsolutePath;
		const topPath = topAbsolutePath.endsWith(path.sep)
			? topAbsolutePath.slice(0, -1)
			: topAbsolutePath;

		if (destPath.startsWith(topPath)) {
			const parts = destPath.split(path.sep);
			return topPath.split(path.sep).every((part, index) => {
				return part === parts[index];
			});
		}
		return false;
	}

	check(destPath: string) {
		if (this.isRootTopRath()) return true;
		return (
			this.checkPath(destPath) && fs.existsSync(this.toAbsolutePath(destPath))
		);
	}

	cd(dirName: string) {
		if (!this.check(dirName)) throw new Error(ERROR_MSG_01);
		this.cwd = normalizedJoin(this.cwd, dirName);
	}

	async list(page: 0, pageSize = 40, searchFileName?: string) {
		if (pageSize > 100 || pageSize <= 0 || page < 0)
			throw new Error("Beyond the value limit");

		// Use withFileTypes option to get file type directly, reducing stat calls
		const dirents = await fs.readdir(this.toAbsolutePath(), {
			withFileTypes: true,
		});

		// Filter search results and create basic file info with type
		let filteredItems = dirents
			.filter(
				(dirent) =>
					!searchFileName ||
					dirent.name.toLowerCase().includes(searchFileName.toLowerCase()),
			)
			.map((dirent) => ({
				name: dirent.name,
				type: dirent.isFile() ? 1 : 0,
			}));

		const total = filteredItems.length;

		// Sort: directories first (type 0), then files (type 1), both alphabetically
		filteredItems.sort((a, b) => {
			if (a.type !== b.type) return a.type - b.type;
			return a.name.localeCompare(b.name);
		});

		const sliceStart = page * pageSize;
		const sliceEnd = sliceStart + pageSize;
		const targetItems = filteredItems.slice(sliceStart, sliceEnd);

		const statPromises = targetItems.map(async (item) => {
			try {
				const abs = this.toAbsolutePath(item.name);
				const info = await fs.stat(abs);
				const mode = parseInt(
					String(parseInt(info.mode?.toString(8), 10)).slice(-3),
				);

				let size = 0;
				if (info.isFile()) {
					size = info.size;
				} else if (info.isDirectory()) {
					// Use background cache service to avoid blocking list
					const cached = dirSizeService.getCached(abs);
					if (typeof cached === "number") {
						size = cached;
					} else {
						size = 0; // not ready yet
						// Warm up cache on read-miss in background
						dirSizeService.enqueue(abs, true);
					}
				}

				return {
					name: item.name,
					size,
					time: info.atime.toString(),
					mode,
					type: item.type,
				};
			} catch (error: any) {
				return {
					name: item.name,
					size: 0,
					time: new Date().toString(),
					mode: 0,
					type: item.type,
				};
			}
		});

		// Execute all stat operations concurrently
		const resultList = await Promise.all(statPromises);

		return {
			items: resultList,
			page,
			pageSize,
			total,
			absolutePath: this.toAbsolutePath(),
		};
	}

	// Recursively calculate directory size in bytes. Skips entries that can't be accessed.
	private async _getDirectorySizeRecursive(dirPath: string): Promise<number> {
		let total = 0;
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dirPath, entry.name);
				try {
					if (entry.isDirectory()) {
						total += await this._getDirectorySizeRecursive(full);
					} else if (entry.isFile()) {
						const st = await fs.stat(full);
						total += st.size;
					}
				} catch (err) {
					// ignore single entry errors
					continue;
				}
			}
		} catch (err) {
			return 0;
		}
		return total;
	}

	async chmod(fileName: string, chmodValue: number, deep: boolean) {
		if (!this.check(fileName) || isNaN(parseInt(chmodValue as any)))
			throw new Error(ERROR_MSG_01);
		const absPath = this.toAbsolutePath(fileName);
		const defaultPath = "/bin/chmod";
		let file = "chmod";
		if (fs.existsSync(defaultPath)) file = defaultPath;
		const params: string[] = [];
		if (deep) params.push("-R");
		params.push(String(chmodValue));
		params.push(absPath);
		return await new ProcessWrapper(file, params, ".", 60 * 10).start();
	}

	async readFile(fileName: string) {
		if (!this.check(fileName)) throw new Error(ERROR_MSG_01);
		const absPath = this.toAbsolutePath(fileName);
		const buf = await fs.readFile(absPath);
		const text = iconv.decode(buf, this.fileCode || "utf-8");
		return text;
	}

	async writeFile(fileName: string, data: string) {
		if (!this.check(fileName)) throw new Error(ERROR_MSG_01);
		const absPath = this.toAbsolutePath(fileName);
		const buf = iconv.encode(data, this.fileCode || "utf-8");
		await fs.writeFile(absPath, buf);
		// Mark parent directory for size recalculation (write request)
		const parentDir = path.dirname(absPath);
		dirSizeService.enqueue(parentDir, true);
	}

	async newFile(fileName: string) {
		if (!this.checkPath(fileName)) throw new Error(ERROR_MSG_01);
		const target = this.toAbsolutePath(fileName);
		fs.createFile(target);
		// Mark parent directory for size recalculation (write request)
		const parentDir = path.dirname(target);
		dirSizeService.enqueue(parentDir, true);
	}

	async copy(target1: string, target2: string) {
		if (!this.checkPath(target2) || !this.check(target1))
			throw new Error(ERROR_MSG_01);
		const targetPath = this.toAbsolutePath(target1);
		target2 = this.toAbsolutePath(target2);
		await fs.copy(targetPath, target2);
		// Mark target directory for size recalculation (write request)
		const targetDir = path.dirname(target2);
		dirSizeService.enqueue(targetDir, true);
	}

	mkdir(target: string) {
		if (!this.checkPath(target)) throw new Error(ERROR_MSG_01);
		const targetPath = this.toAbsolutePath(target);
		fs.mkdirSync(targetPath);
		// Mark parent directory for size recalculation (write request)
		const parentDir = path.dirname(targetPath);
		dirSizeService.enqueue(parentDir, true);
	}

	async delete(target: string): Promise<boolean> {
		if (!this.check(target)) throw new Error(ERROR_MSG_01);
		const targetPath = this.toAbsolutePath(target);
		return new Promise((r, j) => {
			fs.remove(targetPath, (err) => {
				if (!err) {
					// Mark parent directory for size recalculation (write request)
					const parentDir = path.dirname(targetPath);
					dirSizeService.enqueue(parentDir, true);
					r(true);
				} else {
					j(err);
				}
			});
		});
	}

	async move(target: string, destPath: string) {
		if (!this.check(target)) throw new Error(ERROR_MSG_01);
		if (!this.checkPath(destPath)) throw new Error(ERROR_MSG_01);
		const targetPath = this.toAbsolutePath(target);
		destPath = this.toAbsolutePath(destPath);
		await fs.move(targetPath, destPath);
		// Mark both source and destination directories for recalculation (write request)
		const sourceDir = path.dirname(targetPath);
		const destDir = path.dirname(destPath);
		dirSizeService.enqueue(sourceDir, true);
		if (sourceDir !== destDir) {
			dirSizeService.enqueue(destDir, true);
		}
	}

	private zipFileCheck(path: string) {
		const fileInfo = fs.statSync(path);
		const MAX_ZIP_GB = globalConfiguration.config.maxZipFileSize;
		if (fileInfo.size > 1024 * 1024 * 1024 * MAX_ZIP_GB)
			throw new Error(
				$t("TXT_CODE_system_file.unzipLimit", { max: MAX_ZIP_GB }),
			);
	}

	async unzip(sourceZip: string, destDir: string, code?: string) {
		if (!code) code = this.fileCode;
		if (!this.check(sourceZip) || !this.checkPath(destDir))
			throw new Error(ERROR_MSG_01);
		this.zipFileCheck(this.toAbsolutePath(sourceZip));
		const decompression = await decompress(
			this.toAbsolutePath(sourceZip),
			this.toAbsolutePath(destDir),
			code,
		);
		// Mark destination directory for size recalculation (write request)
		const destPath = this.toAbsolutePath(destDir);
		dirSizeService.enqueue(destPath, true);
		return decompression;
	}

	async zip(sourceZip: string, files: string[], code?: string) {
		if (!code) code = this.fileCode;
		if (!this.checkPath(sourceZip)) throw new Error(ERROR_MSG_01);
		const MAX_ZIP_GB = globalConfiguration.config.maxZipFileSize;
		const MAX_TOTAL_FIELS_SIZE = 1024 * 1024 * 1024 * MAX_ZIP_GB;
		const sourceZipPath = this.toAbsolutePath(sourceZip);
		const filesPath = [];
		let totalSize = 0;
		for (const iterator of files) {
			if (this.check(iterator)) {
				filesPath.push(this.toAbsolutePath(iterator));
				try {
					totalSize += fs.statSync(this.toAbsolutePath(iterator))?.size;
				} catch (error: any) {}
			}
		}
		if (totalSize > MAX_TOTAL_FIELS_SIZE)
			throw new Error(
				$t("TXT_CODE_system_file.unzipLimit", { max: MAX_ZIP_GB }),
			);
		await compress(sourceZipPath, filesPath, code);
		// Mark parent directory for size recalculation (write request)
		const parentDir = path.dirname(sourceZipPath);
		dirSizeService.enqueue(parentDir, true);
	}

	async edit(target: string, data?: string) {
		if (!this.check(target)) throw new Error(ERROR_MSG_01);
		if (data || typeof data === "string") {
			return await this.writeFile(target, data);
		} else {
			const absPath = this.toAbsolutePath(target);
			const info = fs.statSync(absPath);
			if (info.size > MAX_EDIT_SIZE) {
				throw new Error($t("TXT_CODE_system_file.execLimit"));
			}
			return await this.readFile(target);
		}
	}

	rename(target: string, newName: string) {
		if (!this.check(target)) throw new Error(ERROR_MSG_01);
		if (!this.checkPath(newName)) throw new Error(ERROR_MSG_01);
		const targetPath = this.toAbsolutePath(target);
		const newPath = this.toAbsolutePath(newName);
		fs.renameSync(targetPath, newPath);
	}

	public static checkFileName(fileName?: string): boolean {
		if (!fileName) return false;
		const blackKeys = ["/", "\\", "|", "?", "*", ">", "<", ";", '"'];
		for (const ch of blackKeys) {
			if (fileName.includes(ch)) return false;
		}
		return true;
	}
}
