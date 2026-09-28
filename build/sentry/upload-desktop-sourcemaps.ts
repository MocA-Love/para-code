/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , platform, arch] = process.argv;
if (!platform || !arch) {
	throw new Error('Usage: node build/sentry/upload-desktop-sourcemaps.ts <platform> <arch>');
}
if (!process.env.SENTRY_AUTH_TOKEN) {
	throw new Error('SENTRY_AUTH_TOKEN is required to upload Para Code source maps');
}
if (!process.env.GITHUB_SHA) {
	throw new Error('GITHUB_SHA is required to create an immutable Sentry release');
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string };
const release = `para-code@${packageJson.version}+${process.env.GITHUB_SHA}`;
const sentryCli = join(repositoryRoot, 'node_modules', '@sentry', 'cli', 'bin', 'sentry-cli');

function runSentryCli(args: string[], label: string): void {
	const result = spawnSync(process.execPath, [sentryCli, ...args], {
		cwd: repositoryRoot,
		env: process.env,
		stdio: 'inherit',
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`sentry-cli ${label} exited with code ${result.status}`);
	}
}

// Create the release explicitly before anything else. The project has "release auto-creation
// from telemetry" turned off (`enableAutoReleaseCreation: false`), and with that setting Sentry
// strips `release` and `dist` from every event whose release does not already exist. The upload
// below does not create it: with Debug IDs, `sourcemaps upload --release` only tags the artifact
// bundle. That is why every 1.139.1 event arrived without a release while the SDK did send one.
// `releases new` is idempotent, so each platform/arch job can run it.
runSentryCli([
	'releases',
	'new',
	release,
	'--org', 'maguro-bot-corp',
	'--project', 'para-code-desktop',
], 'releases new');

runSentryCli([
	'sourcemaps',
	'upload',
	'out-vscode-min',
	'--org', 'maguro-bot-corp',
	'--project', 'para-code-desktop',
	'--release', release,
	'--dist', `${platform}-${arch}`,
	'--url-prefix', 'app:///out',
	'--strip-common-prefix',
	'--validate',
	'--strict',
	// NOTE: do not pass --wait. It blocks on Sentry's server-side processing with a fixed 300s
	// budget, and that budget repeatedly expired *after* the upload itself had already succeeded,
	// failing whole release builds over telemetry post-processing. Sentry processes the bundle
	// asynchronously either way; --validate/--strict still catch bad source maps locally.
], 'sourcemaps upload');
