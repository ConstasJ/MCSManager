import fs from "node:fs";
import path from "node:path";

export async function getDirectorySize(dirPath: string): Promise<number> {
	// Use parallel recursive calculation consistently across all platforms
	// Avoids shell call overhead and ensures predictable performance
	return await getDirectorySizeRecursive(dirPath);
}

export async function getDirectorySizeRecursive(
	dirPath: string,
): Promise<number> {
	let total = 0;
	try {
		const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
		
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
				// ignore entry stat errors
				continue;
			}
		}
		
		// Process subdirectories in parallel for faster I/O utilization
		if (subdirs.length > 0) {
			const subDirPromises = subdirs.map((subdir) =>
				getDirectorySizeRecursive(subdir).catch(() => 0),
			);
			const subDirSizes = await Promise.all(subDirPromises);
			total += subDirSizes.reduce((a, b) => a + b, 0);
		}
		
		// Stat all files in parallel
		if (files.length > 0) {
			const filePromises = files.map((file) =>
				fs.promises
					.stat(file)
					.then((st) => st.size)
					.catch(() => 0),
			);
			const fileSizes = await Promise.all(filePromises);
			total += fileSizes.reduce((a, b) => a + b, 0);
		}
	} catch {
		return 0;
	}
	return total;
}
