/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { GroupDirection } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { createEditorPart, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';

/** 開いている途中（`setInput` の await 中）で止めておける入力。 */
class ParadisSlowEditorInput extends TestFileEditorInput {
	readonly resolving = new DeferredPromise<void>();
	readonly release = new DeferredPromise<void>();

	override async resolve(): Promise<IDisposable | null> {
		this.resolving.complete();
		await this.release.p;
		// 開いている間にグループが消えると、ターミナルのエディタは `setInput` の続きで
		// `Cannot read properties of undefined (reading 'terminalInstance')` を投げる。それの代わり。
		throw new Error('the editor lost its input while it was opening');
	}
}

// Sentry 7T: スペースの切り替え（working set の適用）でエディタグループが作り直される間に、開いている
// 途中のエディタが失敗すると、upstream は失敗を見せるためのエディタを破棄済みのグループの
// InstantiationService で作ろうとして `InstantiationService has been disposed` を投げていた。
suite('Paradis editor open after its group was disposed', () => {
	const disposables = new DisposableStore();
	const editorTypeId = 'paradisEditorOpenAfterGroupDisposed.input';

	teardown(() => disposables.clear());

	ensureNoDisposablesAreLeakedInTestSuite();

	test('stops opening quietly instead of building an error placeholder with disposed services', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		disposables.add(registerTestEditor('paradisEditorOpenAfterGroupDisposed.editor', [new SyncDescriptor(ParadisSlowEditorInput)], editorTypeId));
		const part = await createEditorPart(instantiationService, disposables);
		const group = part.addGroup(part.activeGroup, GroupDirection.RIGHT);
		const input = disposables.add(new ParadisSlowEditorInput(URI.file('/workspace/slow.txt'), editorTypeId));

		const opening = group.openEditor(input, { pinned: true });
		await input.resolving.p;
		part.removeGroup(group, true);
		input.release.complete();

		// 失敗の見せ方（プレースホルダーのエディタ）は作らない。作ると破棄済みのサービスに触る。
		const result = await opening.then(pane => ({ settled: 'resolved', placeholder: pane !== undefined }), (error: Error) => ({ settled: 'rejected', error: error.message }));
		assert.deepStrictEqual(result, { settled: 'resolved', placeholder: false });
	});
});
