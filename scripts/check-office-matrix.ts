/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const { readFileSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve, sep } = require('node:path');

const REQUIRED_COLUMNS = ['id', 'requirement', 'ownerTask', 'behavior', 'fixture', 'unit', 'runtime', 'status', 'commit'] as const;
const ALLOWED_STATUSES = new Set(['implemented', 'safe-fallback', 'intentional-unsupported']);
const FALLBACK_ACTIONS = new Set(['legacy-preview', 'diagnostic', 'explicit-unavailable']);
const FALLBACK_REASONS = new Set(['fail-closed', 'no-unsupported-projection', 'no-external-fetch', 'no-semantic-claim']);
const PLACEHOLDERS = /^(?:pending|future:|historical:|existing regression$|report-office-mock correction$)/i;

function fail(message: string): never {
	console.error(`office matrix: ${message}`);
	process.exit(1);
}

function cells(line: string): string[] {
	return line.trim().slice(1, -1).split('|').map(cell => cell.trim());
}

function isSeparator(line: string): boolean {
	return /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line.trim());
}

function fallbackField(value: string, field: 'action' | 'reason'): string | undefined {
	return new RegExp(`(?:^Fallback:\\s*|;\\s*)${field}=([a-z-]+)(?:;|$)`).exec(value)?.[1];
}

function validFallbackSource(value: string): boolean {
	const source = /(?:^Fallback:\s*|;\s*)source=([^;\s]+)(?:;|$)/.exec(value)?.[1];
	if (!source) {
		return false;
	}
	const [relativePath, symbol, ...extra] = source.split('#');
	if (!relativePath || !symbol || extra.length > 0 || !/^[A-Za-z_$][\w$.-]*$/.test(symbol)) {
		return false;
	}
	const root = resolve(process.cwd());
	const absolute = resolve(root, relativePath);
	if (!absolute.startsWith(`${root}${sep}`)) {
		return false;
	}
	try {
		return statSync(absolute).isFile() && readFileSync(absolute, 'utf8').includes(symbol);
	} catch {
		return false;
	}
}

const file = process.argv[2];
if (!file) {
	fail('usage: node scripts/check-office-matrix.ts <matrix.md>');
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const headerIndex = lines.findIndex(line => line.startsWith('| id |'));
if (headerIndex === -1 || !isSeparator(lines[headerIndex + 1] ?? '')) {
	fail('required audit table was not found');
}

const header = cells(lines[headerIndex]);
const missingColumns = REQUIRED_COLUMNS.filter(column => !header.includes(column));
if (missingColumns.length > 0) {
	fail(`missing required columns: ${missingColumns.join(', ')}`);
}

const index = new Map(header.map((column, columnIndex) => [column, columnIndex]));
const commitIndex = index.get('commit')!;
const errors: string[] = [];
let rows = 0;

for (let lineIndex = headerIndex + 2; lineIndex < lines.length && lines[lineIndex].startsWith('|'); lineIndex++) {
	if (isSeparator(lines[lineIndex])) {
		continue;
	}
	const row = cells(lines[lineIndex]);
	if (row.length !== header.length) {
		errors.push(`line ${lineIndex + 1}: expected ${header.length} columns, got ${row.length}`);
		continue;
	}
	rows++;
	const id = row[index.get('id')!] || `line ${lineIndex + 1}`;
	for (const column of REQUIRED_COLUMNS) {
		const value = row[index.get(column)!];
		if (!value || PLACEHOLDERS.test(value)) {
			errors.push(`${id}: ${column} has no verifiable evidence`);
		}
	}
	const status = row[index.get('status')!];
	if (!ALLOWED_STATUSES.has(status)) {
		errors.push(`${id}: unsupported status ${JSON.stringify(status)}`);
	}
	const behavior = row[index.get('behavior')!];
	const fixture = row[index.get('fixture')!];
	const unit = row[index.get('unit')!];
	const runtime = row[index.get('runtime')!];
	if (status === 'implemented' && (fixture.startsWith('not-run:') || unit.startsWith('not-run:') || runtime.startsWith('not-run:'))) {
		errors.push(`${id}: implemented rows require executed fixture, unit, and runtime evidence`);
	}
	if (status === 'safe-fallback' && (!behavior.startsWith('Fallback:') || !runtime.startsWith('not-run:'))) {
		errors.push(`${id}: safe-fallback requires explicit fallback behavior and an unverified-runtime reason`);
	}
	if (status === 'safe-fallback') {
		const behaviorAction = fallbackField(behavior, 'action');
		const runtimeAction = fallbackField(runtime, 'action');
		const behaviorReason = fallbackField(behavior, 'reason');
		const runtimeReason = fallbackField(runtime, 'reason');
		if (!behaviorAction || !FALLBACK_ACTIONS.has(behaviorAction)) {
			errors.push(`${id}: safe-fallback behavior requires action=legacy-preview|diagnostic|explicit-unavailable`);
		}
		if (!runtimeAction || !FALLBACK_ACTIONS.has(runtimeAction) || runtimeAction !== behaviorAction) {
			errors.push(`${id}: safe-fallback runtime requires the matching structured action`);
		}
		if (!behaviorReason || !FALLBACK_REASONS.has(behaviorReason)) {
			errors.push(`${id}: safe-fallback behavior requires a supported product reason`);
		}
		if (!runtimeReason || runtimeReason !== behaviorReason) {
			errors.push(`${id}: safe-fallback runtime requires the matching structured reason`);
		}
		if (fixture.startsWith('not-run:') && unit.startsWith('not-run:') && runtime.startsWith('not-run:') && !validFallbackSource(behavior)) {
			errors.push(`${id}: all-not-run safe-fallback requires an existing repo-relative source=path#symbol`);
		}
	}
	if (status === 'intentional-unsupported' && (!behavior.includes('Policy:') || !runtime.includes('policy'))) {
		errors.push(`${id}: intentional-unsupported requires explicit policy behavior and reason`);
	}
	const commit = row[commitIndex];
	if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
		errors.push(`${id}: commit must be a Git SHA`);
	} else if (spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD']).status !== 0) {
		errors.push(`${id}: commit is not an ancestor of HEAD`);
	}
}

if (rows === 0) {
	fail('audit table has no rows');
}
if (errors.length > 0) {
	for (const error of errors) {
		console.error(`office matrix: ${error}`);
	}
	process.exit(1);
}

console.log(`office matrix: ${rows} rows validated`);
