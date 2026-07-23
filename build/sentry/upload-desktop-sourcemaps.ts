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
const result = spawnSync(process.execPath, [
	sentryCli,
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
	'--wait',
], {
	cwd: repositoryRoot,
	env: process.env,
	stdio: 'inherit',
});

if (result.error) {
	throw result.error;
}
if (result.status !== 0) {
	throw new Error(`sentry-cli sourcemaps upload exited with code ${result.status}`);
}
