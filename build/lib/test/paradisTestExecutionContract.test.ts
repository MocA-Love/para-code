/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { suite, test } from 'node:test';
import { JSON_SCHEMA, load } from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

interface IWorkflowJob {
	readonly needs?: string | readonly string[];
}

interface IWorkflow {
	readonly on?: Readonly<Record<string, unknown>>;
	readonly jobs: Readonly<Record<string, IWorkflowJob>>;
}

function read(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

function workflow(relativePath: string): IWorkflow {
	return load(read(relativePath), { schema: JSON_SCHEMA }) as IWorkflow;
}

function trackedFiles(): string[] {
	return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 })
		.toString()
		.split('\0')
		.filter(file => file.length > 0 && existsSync(join(repositoryRoot, file)));
}

function isForkTest(file: string): boolean {
	if (!/\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(file)) {
		return false;
	}
	if (file.startsWith('src/vs/paradis/')
		|| file.startsWith('src/vs/sessions/contrib/terminalGrid/')
		|| file.startsWith('app/')
		|| file.startsWith('cloudflare/update-server/')
		|| file.startsWith('test/smoke/src/areas/')) {
		return true;
	}
	if (!['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(file))) {
		return false;
	}
	return /PARA-CODE:|PARA-PATCH:/.test(read(file));
}

function runnerFor(file: string): string | undefined {
	if (/^src\/.*\/test\/.*\.test\.(?:ts|tsx|js)$/.test(file)) {
		return 'vscode-unit';
	}
	if (/^app\/mobile\/src\/.*\.test\.ts$/.test(file)) {
		return 'mobile-vitest';
	}
	if (/^app\/(?:protocol|relay)\/test\/.*\.test\.ts$/.test(file)) {
		return 'app-vitest';
	}
	if (/^cloudflare\/update-server\/src\/.*\.test\.ts$/.test(file)) {
		return 'update-worker-vitest';
	}
	if (/^build\/(?:lib|next|agent-sdk|codex)\/.*\.test\.ts$/.test(file)) {
		return 'build-node-test';
	}
	if (/^extensions\/git\/src\/test\/.*\.test\.ts$/.test(file)) {
		return 'git-extension-integration';
	}
	if (/^test\/smoke\/src\/areas\/.*\.test\.ts$/.test(file)) {
		return 'smoke';
	}
	if (/^src\/vs\/sessions\/test\/e2e\/.*\.spec\.ts$/.test(file)) {
		return 'sessions-playwright';
	}
	return undefined;
}

suite('Para Code test execution contract', () => {
	test('every fork test file belongs to an active runner family', () => {
		const forkTests = trackedFiles().filter(isForkTest);
		const unwired = forkTests.filter(file => runnerFor(file) === undefined);

		assert.ok(forkTests.length > 0);
		assert.deepStrictEqual(unwired, []);
	});

	test('PR, desktop release, and REH release all require the complete Para CI workflow', () => {
		const ci = workflow('.github/workflows/para-ci.yml');
		const expectedJobs = [
			'unit-tests',
			'electron-tests',
			'electron-smoke-tests',
			'browser-tests',
			'browser-smoke-tests',
			'remote-tests',
			'remote-smoke-tests',
			'sessions-e2e',
			'fork-workspace-tests',
			'copilot-checks',
		];
		assert.strictEqual(Object.hasOwn(ci.on ?? {}, 'workflow_call'), true);
		assert.deepStrictEqual(expectedJobs.filter(job => !Object.hasOwn(ci.jobs, job)), []);

		for (const file of ['.github/workflows/para-release.yml', '.github/workflows/para-reh.yml']) {
			const release = workflow(file);
			assert.ok(release.jobs['verify'], `${file} has no Para CI verification job`);
			for (const [name, job] of Object.entries(release.jobs).filter(([name]) => name.startsWith('build-'))) {
				const needs = typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
				assert.ok(needs.includes('verify'), `${file} job ${name} does not require Para CI`);
			}
		}
	});
});
