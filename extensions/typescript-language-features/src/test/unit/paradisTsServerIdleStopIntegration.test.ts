/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import 'mocha';
import * as vscode from 'vscode';

/** TS Server processes that this extension host started. */
function tsServerProcessCount(): number {
	try {
		return execFileSync('pgrep', ['-P', String(process.pid), '-f', 'tsserver'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
	} catch {
		return 0; // pgrep exits with 1 when nothing matches
	}
}

async function waitFor(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 30000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	const open = vscode.workspace.textDocuments.map(document => `${document.uri.toString()} (${document.languageId}${document.isDirty ? ', dirty' : ''})`);
	assert.fail(`timed out waiting for ${what}; open documents: ${open.join(', ')}`);
}

async function closeAllEditors(): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

const isTsDocumentOpen = () => vscode.workspace.textDocuments.some(document => document.languageId === 'typescript');

(process.platform === 'win32' ? suite.skip : suite)('Para Code: TS Server idle stop (extension host)', () => {
	const workspace = vscode.workspace.workspaceFolders![0].uri;
	const importer = vscode.Uri.joinPath(workspace, 'paradisIdleImporter.ts');
	const target = vscode.Uri.joinPath(workspace, 'paradisIdleTarget.ts');
	const renamed = vscode.Uri.joinPath(workspace, 'paradisIdleRenamed.ts');

	suiteSetup(async () => {
		await vscode.workspace.fs.writeFile(target, Buffer.from('export const paradisIdle = 1;\n'));
		await vscode.workspace.fs.writeFile(importer, Buffer.from(`import { paradisIdle } from './paradisIdleTarget';\nexport const value = paradisIdle;\n`));
		await vscode.workspace.getConfiguration('js/ts').update('updateImportsOnFileMove.enabled', 'always', vscode.ConfigurationTarget.Global);
		// 0.02 minutes = 1.2 seconds
		await vscode.workspace.getConfiguration('paradis.typescript').update('idleStopMinutes', 0.02, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await closeAllEditors();
		await vscode.workspace.getConfiguration('paradis.typescript').update('idleStopMinutes', undefined, vscode.ConfigurationTarget.Global);
		await vscode.workspace.getConfiguration('js/ts').update('updateImportsOnFileMove.enabled', undefined, vscode.ConfigurationTarget.Global);
		for (const file of [importer, target, renamed]) {
			await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
		}
	});

	test('stops when no TS document is left, updates imports on a rename while stopped, and starts again on open', async function () {
		// Documents opened through the extension API (this test, and the rename for the moved file) are released by the workbench after up to 3 minutes.
		this.timeout(10 * 60 * 1000);
		// Start TS Server by opening a file and asking for something.
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(importer));
		await waitFor('TS Server to answer', async () => {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', importer, new vscode.Position(1, 16));
			return hovers.length > 0;
		});
		assert.ok(tsServerProcessCount() > 0, 'TS Server is running');

		// Nothing open: TS Server is stopped after the idle time.
		await closeAllEditors();
		await waitFor('the document to close', () => !isTsDocumentOpen(), 4 * 60 * 1000);
		await waitFor('TS Server to stop', () => tsServerProcessCount() === 0);

		// A rename while stopped starts TS Server again and still updates the import.
		const edit = new vscode.WorkspaceEdit();
		edit.renameFile(target, renamed);
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitFor('the import to be updated', () => !!vscode.workspace.textDocuments.find(document => document.uri.toString() === importer.toString())?.getText().includes(`'./paradisIdleRenamed'`), 60000);
		assert.ok(tsServerProcessCount() > 0, 'TS Server started again for the rename');

		// Stopped again once nothing is open, then started again by opening a file.
		// A dirty document is still in use, so save the edited importer first.
		const edited = vscode.workspace.textDocuments.find(document => document.uri.toString() === importer.toString());
		assert.ok(await edited?.save(), 'saved the updated import');
		await closeAllEditors();
		await waitFor('the documents to close', () => !isTsDocumentOpen(), 4 * 60 * 1000);
		await waitFor('TS Server to stop again', () => tsServerProcessCount() === 0);

		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(importer));
		await waitFor('TS Server to answer after the stop', async () => {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', importer, new vscode.Position(1, 16));
			return hovers.length > 0;
		});
		assert.ok(tsServerProcessCount() > 0, 'TS Server started again on open');
	});
});
