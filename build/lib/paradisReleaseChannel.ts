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
 * The same tag patterns give the Sentry release name of a build (`getParadisSentryRelease`).
 *
 * CLI:
 * - `node build/lib/paradisReleaseChannel.ts` reads GitHub's GITHUB_EVENT_NAME / GITHUB_REF_TYPE /
 *   GITHUB_REF_NAME plus PARA_RELEASE_PLATFORMS (the workflow_dispatch `platforms` input), appends the
 *   plan to $GITHUB_OUTPUT and exits 1 for a rejected tag.
 * - `node build/lib/paradisReleaseChannel.ts previous-stable <tag>` reads release tag names (one per
 *   line) from stdin and prints the stable tag that precedes <tag>, or nothing. The stable GitHub
 *   Release passes it to `--notes-start-tag` so its notes never start from a beta tag.
 * - `node build/lib/paradisReleaseChannel.ts feed-fields <tag>` prints the `"paracode":<N>` (and, for a
 *   beta, `"paracodeBeta":<M>`) JSON members the publish job adds to every feed KV record.
 * - `node build/lib/paradisReleaseChannel.ts check-feed <tag> <kv key>` reads the current feed KV record
 *   from stdin (empty when the key does not exist yet) and exits 1 when it holds a newer release than
 *   <tag>, so re-running an old tag cannot roll every client back (q.html Q635).
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

const PARADIS_RELEASE_TAG_NUMBERS_PATTERN = /-paracode-(?<number>\d+)(?:-beta\.(?<beta>\d+))?$/;
const PARADIS_SENTRY_BASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * The Sentry release name of a build. The desktop client reads it from product.json
 * (`paradisSentryRelease`, stamped by build/gulpfile.vscode.ts) and
 * build/sentry/upload-desktop-sourcemaps.ts creates the release under it, so both call
 * {@link getParadisSentryReleaseFromEnv} with the same inputs.
 *
 * Sentry orders semver releases by `<major>.<minor>.<patch>.<revision>` numerically, then a release
 * without a prerelease above one with it, then the prerelease as a plain string, then the build
 * (`+...`) as a number when both are numeric and as a string otherwise. The old names differed only
 * in the commit, so their order was the order of the commit hashes, and a resolved issue could not
 * be detected as a regression. The paracode number is therefore the fourth (revision) component:
 * - stable tag `v1.139.1-paracode-148`        → `para-code@1.139.1.148+<commit>`
 * - beta tag   `v1.139.1-paracode-148-beta.2` → `para-code@1.139.1.148-beta.2+<commit>` (below stable 148, above 147)
 * - anything else (branch builds, local builds) → `para-code@1.139.1+<commit>` as before, which sorts
 *   below every tagged release of the same upstream version.
 * Betas of one number compare as strings, so `beta.10` sorts before `beta.2`.
 */
export function getParadisSentryRelease(version: string, commit: string | undefined, ref: Pick<IParadisReleaseRef, 'refType' | 'refName'>): string {
	const build = commit ? `+${commit}` : '';
	const kind = ref.refType === 'tag' ? classifyParadisReleaseTag(ref.refName) : 'other';
	const numbers = PARADIS_RELEASE_TAG_NUMBERS_PATTERN.exec(ref.refName)?.groups;
	if (kind === 'other' || !numbers || !PARADIS_SENTRY_BASE_VERSION_PATTERN.test(version)) {
		return `para-code@${version}${build}`;
	}
	const beta = kind === 'beta' ? `-beta.${Number(numbers.beta)}` : '';
	return `para-code@${version}.${Number(numbers.number)}${beta}${build}`;
}

/** {@link getParadisSentryRelease} for the ref GitHub Actions runs on (`GITHUB_REF_TYPE` / `GITHUB_REF_NAME`). */
export function getParadisSentryReleaseFromEnv(version: string, commit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
	return getParadisSentryRelease(version, commit, { refType: env.GITHUB_REF_TYPE ?? '', refName: env.GITHUB_REF_NAME ?? '' });
}

const PARADIS_STABLE_TAG_NUMBER_PATTERN = /-paracode-(?<number>\d+)$/;

function getParadisStableTagNumber(tag: string): number | undefined {
	if (classifyParadisReleaseTag(tag) !== 'stable') {
		return undefined;
	}
	const match = PARADIS_STABLE_TAG_NUMBER_PATTERN.exec(tag);
	return match?.groups ? Number(match.groups.number) : undefined;
}

/**
 * The stable tag with the highest `paracode-<N>` below the one of `currentTag`. Beta tags, other tags
 * and tags at or above the current number are ignored, so re-running an old tag still starts its
 * notes at the stable release before it. `undefined` when there is none or `currentTag` is not stable.
 */
export function findPreviousParadisStableTag(currentTag: string, tags: readonly string[]): string | undefined {
	const current = getParadisStableTagNumber(currentTag);
	if (current === undefined) {
		return undefined;
	}
	let previous: { readonly tag: string; readonly number: number } | undefined;
	for (const tag of tags) {
		const number = getParadisStableTagNumber(tag.trim());
		if (number !== undefined && number < current && (!previous || number > previous.number)) {
			previous = { tag: tag.trim(), number };
		}
	}
	return previous?.tag;
}

/** The release numbers of a stable or beta tag; `beta` is undefined for a stable tag. */
export interface IParadisReleaseNumbers {
	readonly paracode: number;
	readonly beta?: number;
}

/** `undefined` unless `tag` is a stable or beta release tag. */
export function getParadisReleaseNumbers(tag: string): IParadisReleaseNumbers | undefined {
	if (classifyParadisReleaseTag(tag) === 'other') {
		return undefined;
	}
	const numbers = PARADIS_RELEASE_TAG_NUMBERS_PATTERN.exec(tag)?.groups;
	if (!numbers) {
		return undefined;
	}
	return numbers.beta === undefined ? { paracode: Number(numbers.number) } : { paracode: Number(numbers.number), beta: Number(numbers.beta) };
}

/**
 * The JSON members (without braces) the publish job appends to a feed KV record of `tag`, e.g.
 * `"paracode":146` or `"paracode":146,"paracodeBeta":1`. `undefined` for a non-release tag.
 */
export function formatParadisFeedReleaseFields(tag: string): string | undefined {
	const numbers = getParadisReleaseNumbers(tag);
	if (!numbers) {
		return undefined;
	}
	return numbers.beta === undefined ? `"paracode":${numbers.paracode}` : `"paracode":${numbers.paracode},"paracodeBeta":${numbers.beta}`;
}

/**
 * Orders releases by `paracode-<N>`, then by `beta.<M>` numerically; a stable release is above
 * every beta of the same N (the same order as {@link getParadisSentryRelease}, except that betas
 * compare as numbers).
 */
function compareParadisReleaseNumbers(a: IParadisReleaseNumbers, b: IParadisReleaseNumbers): number {
	if (a.paracode !== b.paracode) {
		return a.paracode - b.paracode;
	}
	return (a.beta ?? Number.POSITIVE_INFINITY) - (b.beta ?? Number.POSITIVE_INFINITY);
}

export interface IParadisFeedCheck {
	readonly publish: boolean;
	readonly message: string;
}

/**
 * Whether the publish job may overwrite the feed KV record `kvKey` (whose current value is
 * `currentRecord`, empty when the key does not exist) with the release of `tag`.
 * - No record yet, or a record written before the release numbers were stored → publish.
 * - The same release (re-running the same tag to recover a failed publish) → publish.
 * - A newer release → stop. The update server offers every client any commit that differs from
 *   its own, so overwriting it would "update" everyone back to the older release.
 * A record that is not JSON stops the run, so an unexpected wrangler output is never overwritten blindly.
 */
export function checkParadisFeedRecord(tag: string, kvKey: string, currentRecord: string): IParadisFeedCheck {
	const release = getParadisReleaseNumbers(tag);
	if (!release) {
		return { publish: false, message: `'${tag}' is not a release tag; the feed is not written.` };
	}
	if (currentRecord.trim() === '') {
		return { publish: true, message: `${kvKey}: no record yet.` };
	}
	let record: unknown;
	try {
		record = JSON.parse(currentRecord);
	} catch {
		return { publish: false, message: `${kvKey}: the current record is not JSON; the feed is not written.` };
	}
	const stored = record && typeof record === 'object' ? record as { readonly paracode?: unknown; readonly paracodeBeta?: unknown } : {};
	if (typeof stored.paracode !== 'number') {
		return { publish: true, message: `${kvKey}: the current record has no release number (written before they were stored).` };
	}
	const current: IParadisReleaseNumbers = typeof stored.paracodeBeta === 'number' ? { paracode: stored.paracode, beta: stored.paracodeBeta } : { paracode: stored.paracode };
	const describe = (numbers: IParadisReleaseNumbers) => numbers.beta === undefined ? `paracode-${numbers.paracode}` : `paracode-${numbers.paracode}-beta.${numbers.beta}`;
	if (compareParadisReleaseNumbers(current, release) > 0) {
		return {
			publish: false,
			message: `${kvKey} already serves ${describe(current)}, newer than ${tag}; nothing is published so clients are not rolled back. To roll back, tag the older commit with a new paracode number (NOTES.md).`,
		};
	}
	return { publish: true, message: `${kvKey}: ${describe(current)} -> ${describe(release)}.` };
}

/**
 * The `classify` step outputs (`steps.plan.outputs.*`) the workflows read. Exported for the
 * workflow contract test, which feeds them through the real `if:` and `env:` expressions.
 */
export function toParadisReleaseOutputs(plan: IParadisReleasePlan): Record<string, string> {
	return {
		kind: plan.kind,
		channel: plan.channel,
		is_beta: String(plan.isBeta),
		publish: String(plan.publish),
		build_darwin: String(plan.buildDarwin),
		build_win32: String(plan.buildWin32),
		build_linux: String(plan.buildLinux),
	};
}

function toGitHubOutput(plan: IParadisReleasePlan): string {
	return Object.entries(toParadisReleaseOutputs(plan)).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

if (import.meta.main && process.argv[2] === 'feed-fields') {
	const fields = formatParadisFeedReleaseFields(process.argv[3] ?? '');
	if (!fields) {
		console.error(`::error::'${process.argv[3] ?? ''}' is not a release tag.`);
		process.exit(1);
	}
	process.stdout.write(fields);
} else if (import.meta.main && process.argv[2] === 'check-feed') {
	const check = checkParadisFeedRecord(process.argv[3] ?? '', process.argv[4] ?? '', fs.readFileSync(0, 'utf8'));
	if (!check.publish) {
		console.error(`::error::${check.message}`);
		process.exit(1);
	}
	console.log(check.message);
} else if (import.meta.main && process.argv[2] === 'previous-stable') {
	const previous = findPreviousParadisStableTag(process.argv[3] ?? '', fs.readFileSync(0, 'utf8').split('\n'));
	if (previous) {
		process.stdout.write(`${previous}\n`);
	}
} else if (import.meta.main) {
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
