/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/*
 * Decides what a run of .github/workflows/para-release.yml (and para-reh.yml) is allowed to do,
 * from the git ref it runs on. Kept in one place so the release and REH workflows cannot disagree
 * and so the tag patterns are unit tested (build/lib/test/paradisReleaseChannel.test.ts).
 *
 * - Stable tag `v<ver>-paracode-<N>`          → channel stable, all platforms, publish (unchanged).
 * - Beta tag   `v<ver>-paracode-<N>-beta.<M>` → channel beta, macOS only, publish to beta/ + beta:*.
 * - Any other tag                             → rejected: nothing is built or published.
 * - A branch (workflow_dispatch)              → build only, never publish.
 *
 * CLI: `node build/lib/paradisReleaseChannel.ts` reads GitHub's GITHUB_EVENT_NAME / GITHUB_REF_TYPE /
 * GITHUB_REF_NAME plus PARA_RELEASE_PLATFORMS (the workflow_dispatch `platforms` input), appends the
 * plan to $GITHUB_OUTPUT and exits 1 for a rejected tag.
 */

import * as fs from 'fs';

const PARADIS_STABLE_TAG_PATTERN = /^v\d+\.\d+\.\d+-paracode-\d+$/;
const PARADIS_BETA_TAG_PATTERN = /^v\d+\.\d+\.\d+-paracode-\d+-beta\.\d+$/;

export type ParadisReleaseTagKind = 'stable' | 'beta' | 'other';

export function classifyParadisReleaseTag(tag: string): ParadisReleaseTagKind {
	if (PARADIS_STABLE_TAG_PATTERN.test(tag)) {
		return 'stable';
	}
	if (PARADIS_BETA_TAG_PATTERN.test(tag)) {
		return 'beta';
	}
	return 'other';
}

export interface IParadisReleaseRef {
	readonly eventName: string;
	readonly refType: string;
	readonly refName: string;
	/** `platforms` input of workflow_dispatch; empty for tag pushes. */
	readonly platforms: string;
}

export interface IParadisReleasePlan {
	readonly kind: ParadisReleaseTagKind | 'branch';
	/** Value for PARA_UPDATE_CHANNEL (stamped into product.json by build/gulpfile.vscode.ts unless stable). */
	readonly channel: 'stable' | 'beta';
	readonly isBeta: boolean;
	readonly publish: boolean;
	readonly buildDarwin: boolean;
	readonly buildWin32: boolean;
	readonly buildLinux: boolean;
	/** Set when the run must stop before building anything. */
	readonly error?: string;
}

export function planParadisRelease(ref: IParadisReleaseRef): IParadisReleasePlan {
	const kind = ref.refType === 'tag' ? classifyParadisReleaseTag(ref.refName) : 'branch';
	const isBeta = kind === 'beta';
	// Same rule the build jobs used before: tag pushes and dispatches without `platforms` build
	// everything, a `platforms` subset builds only the listed ones and never publishes.
	const allPlatforms = ref.eventName !== 'workflow_dispatch' || ref.platforms === '';
	// GitHub's contains() is case-insensitive; keep that.
	const selected = (platform: string) => allPlatforms || ref.platforms.toLowerCase().includes(platform);

	if (kind === 'other') {
		return {
			kind, channel: 'stable', isBeta: false, publish: false,
			buildDarwin: false, buildWin32: false, buildLinux: false,
			error: `Tag '${ref.refName}' is neither a stable tag (v<ver>-paracode-<N>) nor a beta tag (v<ver>-paracode-<N>-beta.<M>); nothing is built or published.`,
		};
	}

	return {
		kind,
		channel: isBeta ? 'beta' : 'stable',
		isBeta,
		// Publishing (R2, KV, GitHub Release, reh Release) only ever happens from a release tag.
		publish: kind !== 'branch' && allPlatforms,
		buildDarwin: selected('darwin'),
		// Beta builds exist to ship macOS-only features (Computer Use), so the other platforms are skipped.
		buildWin32: !isBeta && selected('win32'),
		buildLinux: !isBeta && selected('linux'),
	};
}

function toGitHubOutput(plan: IParadisReleasePlan): string {
	return [
		`kind=${plan.kind}`,
		`channel=${plan.channel}`,
		`is_beta=${plan.isBeta}`,
		`publish=${plan.publish}`,
		`build_darwin=${plan.buildDarwin}`,
		`build_win32=${plan.buildWin32}`,
		`build_linux=${plan.buildLinux}`,
	].join('\n') + '\n';
}

if (import.meta.main) {
	const plan = planParadisRelease({
		eventName: process.env['GITHUB_EVENT_NAME'] ?? '',
		refType: process.env['GITHUB_REF_TYPE'] ?? '',
		refName: process.env['GITHUB_REF_NAME'] ?? '',
		platforms: process.env['PARA_RELEASE_PLATFORMS'] ?? '',
	});
	const output = toGitHubOutput(plan);
	process.stdout.write(output);
	const outputFile = process.env['GITHUB_OUTPUT'];
	if (outputFile) {
		fs.appendFileSync(outputFile, output);
	}
	if (plan.error) {
		console.error(`::error::${plan.error}`);
		process.exit(1);
	}
}
