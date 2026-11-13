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
	/**
	 * `paracode-<N>` of the release tag. The release CI reads it before writing,
	 * and does not overwrite a record that holds a newer release (q.html Q635).
	 * Absent on records written before it was stored. The worker ignores it.
	 */
	readonly paracode?: number;
	/** `beta.<M>` of a beta release tag; absent for a stable release. */
	readonly paracodeBeta?: number;
}

export interface Env {
	readonly RELEASES: KVNamespace;
	/** AUD tag of the Access Application in front of `/api/update`. */
	readonly CF_ACCESS_AUD?: string;
	/** Team domain that issues the Access JWTs, e.g. `https://<team>.cloudflareaccess.com`. */
	readonly CF_ACCESS_TEAM_DOMAIN?: string;
}
