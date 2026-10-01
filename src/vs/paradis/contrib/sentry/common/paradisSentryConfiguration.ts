/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const PARADIS_SENTRY_DESKTOP_DSN = 'https://c854d2571bf85beb19b9a8abd94240aa@o4511131276804096.ingest.us.sentry.io/4511784070676480';
/**
 * 配布ビルドの environment。
 *
 * 'development' 固定だった頃は、パッケージ版の実使用も VSCODE_DEV 以外は全部 development に
 * なり、実ユーザーが踏んだ障害とローカル検証のノイズが Sentry 上で区別できなかった
 * （production という環境自体が存在しなかった）。CI のスモークテストは {@link paradisSentryEnvironment}
 * が 'local' に振り分け、ソースから起動した開発ビルドはそもそも送らない（{@link isParadisSentryDevelopmentBuild}）。
 */
export const PARADIS_SENTRY_ENVIRONMENT = 'production';

/** The variables read from the process environment (Node's `process.env` or `vs/base/common/process`). */
export interface IParadisSentryProcessEnvironment {
	readonly VSCODE_DEV?: string;
	readonly CI?: string;
	readonly GITHUB_ACTIONS?: string;
}

/**
 * Whether this process belongs to a build run out of sources (`VSCODE_DEV`, set by `scripts/code.sh`).
 *
 * Such builds do not initialize Sentry in any process (main, renderer, shared process): local
 * debugging produced only noise there, and 105 issues of it had to be ignored by hand (2026-10-01).
 * Same test as upstream's `isBuilt` (`!env['VSCODE_DEV']`), so the two can never disagree.
 */
export function isParadisSentryDevelopmentBuild(env: IParadisSentryProcessEnvironment): boolean {
	return !!env.VSCODE_DEV;
}

/** `CI=false` is set explicitly by some tools, so a plain truthiness check would misfire. */
function isTruthyEnv(value: string | undefined): boolean {
	return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

/**
 * The environment a desktop event is filed under. CI smoke tests run the *packaged* build without
 * `VSCODE_DEV`, so they still report, but as 'local' so they never mix with real users' production.
 */
export function paradisSentryEnvironment(env: IParadisSentryProcessEnvironment): string {
	return isParadisSentryDevelopmentBuild(env) || isTruthyEnv(env.CI) || isTruthyEnv(env.GITHUB_ACTIONS)
		? 'local'
		: PARADIS_SENTRY_ENVIRONMENT;
}

/**
 * The release every desktop event carries. Packaged builds use the name stamped into product.json
 * (`paradisSentryRelease`, e.g. `para-code@1.139.1.148+<commit>` for the tag `v1.139.1-paracode-148`),
 * which the release build also creates in Sentry and uploads the source maps under
 * (build/lib/paradisReleaseChannel.ts has the naming rule). Builds without the stamp (running out of
 * sources) fall back to `para-code@<version>+<commit>`.
 */
export function paradisSentryRelease(version: string, commit?: string, stampedRelease?: string): string {
	const stamped = stampedRelease?.trim();
	if (stamped) {
		return stamped;
	}
	return `para-code@${version}${commit ? `+${commit}` : ''}`;
}
