/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const execFileAsync = promisify(execFile);

/**
 * powerlevel10k emits its own OSC 133 markers and, to avoid doubling up, runs an unconditional
 * `unset VSCODE_SHELL_INTEGRATION` (p10k 1.20.15, `internal/p10k.zsh`, near
 * `__p9k_force_term_shell_integration`). VS Code's rc script reads a cleared flag as "the shell
 * opted out" and returns before installing its hooks, so no command line is ever reported: every
 * command stays untrusted with the line recovered from the screen buffer, which silently disables
 * each feature that needs the real one.
 *
 * These tests pin the PARA-PATCH that restores the flag. Losing it in an upstream merge brings
 * back a failure whose only symptom is features quietly doing nothing.
 *
 * They deliberately live outside any one feature directory: the patch serves the whole terminal,
 * so deleting a feature must not take its guard along.
 *
 * Known limit: the p10k-style case below sets the sentinel itself, so it cannot notice p10k
 * renaming or dropping `__p9k_force_term_shell_integration`. Should that happen, the patch stops
 * applying while these stay green — re-check against the real p10k source when bumping it.
 */
suite('Paradis shell integration (powerlevel10k)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The built copy under `out/`, which is what a running window actually sources.
	const scriptPath = FileAccess.asFileUri('vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh').fsPath;

	let zshAvailable = false;
	suiteSetup(async () => {
		zshAvailable = await execFileAsync('zsh', ['-c', 'exit 0']).then(() => true, () => false);
	});

	/** Sources the rc script the way an injected shell does, and reports what survived. */
	async function sourceWithUserRc(userRc: string): Promise<string> {
		const home = await fs.mkdtemp(join(tmpdir(), 'paradis-si-'));
		try {
			await fs.writeFile(join(home, '.zshrc'), userRc);
			// A window running these tests exports its own integration state; drop it so the
			// script sees a clean injection rather than the outer terminal's.
			const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_')));
			const { stdout } = await execFileAsync('zsh', ['-c',
				`USER_ZDOTDIR=${JSON.stringify(home)} VSCODE_INJECTION=1 builtin source ${JSON.stringify(scriptPath)} >/dev/null 2>&1; ` +
				`print -r -- "SI=[$VSCODE_SHELL_INTEGRATION] HOOK=[$(typeset -f __vsc_preexec >/dev/null 2>&1 && print yes || print no)]"`,
			], { env: { ...env, ZDOTDIR: home } });
			return stdout.trim();
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}

	test('the rc script restores the flag that powerlevel10k clears', async () => {
		const script = await fs.readFile(scriptPath, 'utf8');
		const patch = script.indexOf('__p9k_force_term_shell_integration');
		const guard = script.indexOf('if [ -z "$VSCODE_SHELL_INTEGRATION" ]; then');
		assert.notStrictEqual(patch, -1, 'PARA-PATCH restoring VSCODE_SHELL_INTEGRATION is missing');
		// Restoring the flag after the guard that reads it would be worthless.
		assert.ok(patch < guard, 'PARA-PATCH must run before the shell-opted-out guard');
	});

	test('a p10k-style shell ends up with shell integration enabled', async function () {
		if (!zshAvailable) {
			this.skip();
		}
		assert.strictEqual(
			await sourceWithUserRc('typeset -gri __p9k_force_term_shell_integration=1\nunset VSCODE_SHELL_INTEGRATION\n'),
			'SI=[1] HOOK=[yes]');
	});

	test('a shell that opts out on its own is still respected', async function () {
		if (!zshAvailable) {
			this.skip();
		}
		// No sentinel: this is a shell deliberately declining shell integration, and the patch
		// must not drag it back in.
		assert.strictEqual(await sourceWithUserRc('unset VSCODE_SHELL_INTEGRATION\n'), 'SI=[] HOOK=[no]');
	});
});
