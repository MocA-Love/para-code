// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * One release's metadata for a single (quality, platform) pair, as stored in
 * the RELEASES KV namespace. Written by the release CI after it uploads the
 * signed build artifact to R2 (see .github/workflows/para-release.yml).
 *
 * KV key: `${quality}:${platform}` — matches the path segments VS Code's
 * update client sends (see createUpdateURL() in
 * src/vs/platform/update/electron-main/abstractUpdateService.ts).
 */
export interface IReleaseRecord {
	readonly commit: string;
	readonly version: string;
	readonly productVersion: string;
	readonly url: string;
	readonly sha256hash?: string;
	readonly timestamp: number;
}

export interface Env {
	readonly RELEASES: KVNamespace;
	readonly CF_ACCESS_AUD?: string;
}
