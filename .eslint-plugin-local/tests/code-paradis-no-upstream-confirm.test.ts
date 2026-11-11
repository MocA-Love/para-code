/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RuleTester } from 'eslint';
import { suite, test } from 'node:test';
import tseslint from 'typescript-eslint';
import rule from '../code-paradis-no-upstream-confirm.ts';

RuleTester.describe = suite;
RuleTester.it = test;

const reported = [{ messageId: 'upstreamConfirm' }];

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run('code-paradis-no-upstream-confirm', rule, {
	valid: [
		`await paradisDialogService.confirm({ message: 'a' });`,
		`await this.paradisDialogService.confirm({ message: 'a' });`,
		`await accessor.get(IParadisDialogService).confirm({ message: 'a' });`,
		`await this.confirm(entries);`,
		`await editor.closeHandler.confirm([editor]);`,
		`await this.windowService(id).confirm(summary);`,
		`await dialogService.prompt({ message: 'a', buttons: [] });`,
	],
	invalid: [
		{ code: `await dialogService.confirm({ message: 'a' });`, errors: reported },
		{ code: `await this.dialogService.confirm({ message: 'a' });`, errors: reported },
		{ code: `await this._dialogService.confirm({ message: 'a' });`, errors: reported },
		{ code: `await services.dialogService.confirm({ message: 'a' });`, errors: reported },
		{ code: `await accessor.get(IDialogService).confirm({ message: 'a' });`, errors: reported },
	],
});
