/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const checker = join(process.cwd(), 'scripts/check-office-matrix.ts');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

function check(behavior: string, runtime: string): number {
	const directory = mkdtempSync(join(tmpdir(), 'office-matrix-'));
	const matrix = join(directory, 'matrix.md');
	writeFileSync(matrix, [
		'| id | requirement | ownerTask | behavior | fixture | unit | runtime | status | commit |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
		`| T-01 | test | owner | ${behavior} | not-run: fixture | not-run: unit | ${runtime} | safe-fallback | ${head} |`,
	].join('\n'));
	try {
		return spawnSync(process.execPath, [checker, matrix], { encoding: 'utf8' }).status ?? -1;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('rejects a generic safe-fallback that has no structured UI action or policy reason', () => {
	assert.notEqual(check('Fallback: show a blank screen', 'not-run: x'), 0);
});

test('accepts a safe-fallback with matching structured action and product reason', () => {
	assert.equal(check(
		'Fallback: action=legacy-preview; reason=no-semantic-claim; source=src/vs/paradis/contrib/fileViewers/electron-browser/paradisSpreadsheetEditor.ts#isParadisSpreadsheetV1Enabled; existing preview remains available.',
		'not-run: target=desktop:xlsx-render; action=legacy-preview; reason=no-semantic-claim; runtime not executed.',
	), 0);
});

test('rejects all-not-run fallback evidence when the source is absent or nonexistent', () => {
	assert.notEqual(check(
		'Fallback: action=legacy-preview; reason=no-semantic-claim; existing preview remains available.',
		'not-run: target=desktop:xlsx-render; action=legacy-preview; reason=no-semantic-claim; runtime not executed.',
	), 0);
	assert.notEqual(check(
		'Fallback: action=legacy-preview; reason=no-semantic-claim; source=src/does-not-exist.ts#fallback; existing preview remains available.',
		'not-run: target=desktop:xlsx-render; action=legacy-preview; reason=no-semantic-claim; runtime not executed.',
	), 0);
});
