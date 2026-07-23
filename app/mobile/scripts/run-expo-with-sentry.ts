// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const commandArgs = process.argv.slice(2);
if (commandArgs.length === 0) {
	throw new Error('An Expo command is required');
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryEnvPath = resolve(scriptDirectory, '..', '..', '..', '.env');
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
	?? process.env.SENTRY_PAT
	?? readEnvValue(repositoryEnvPath, 'SENTRY_PAT');
if (!sentryAuthToken) {
	throw new Error('SENTRY_AUTH_TOKEN or SENTRY_PAT is required for native builds with Sentry source maps');
}

const require = createRequire(import.meta.url);
const expoCli = require.resolve('expo/bin/cli');
const result = spawnSync(process.execPath, [expoCli, ...commandArgs], {
	cwd: resolve(scriptDirectory, '..'),
	env: { ...process.env, SENTRY_AUTH_TOKEN: sentryAuthToken },
	stdio: 'inherit',
});
if (result.error) {
	throw result.error;
}
if (result.status !== 0) {
	process.exitCode = result.status ?? 1;
}

function readEnvValue(path: string, key: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`));
		if (!match) {
			continue;
		}
		const value = match[1];
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			return value.slice(1, -1);
		}
		return value;
	}
	return undefined;
}
