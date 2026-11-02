/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { ParadisResourcePairDiffInput, ParadisResourcePairDiffInputSerializer } from '../../browser/paradisResourcePairDiffInput.js';

class TestDiffInput extends ParadisResourcePairDiffInput {
	override get typeId(): string { return 'test.diff'; }
}

class TestDiffSerializer extends ParadisResourcePairDiffInputSerializer<TestDiffInput> {
	readonly created: TestDiffInput[] = [];
	protected owns(editor: EditorInput): editor is TestDiffInput { return editor instanceof TestDiffInput; }
	protected createInput(_instantiationService: IInstantiationService, original: URI, modified: URI, label: string | undefined): TestDiffInput {
		const input = new TestDiffInput(original, modified, label);
		this.created.push(input);
		return input;
	}
}

suite('ParadisResourcePairDiffInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('saves only the given name, and reads a saved default name from the earlier format as no name', () => {
		const original = URI.parse('git:/repo/book.md?ref=HEAD');
		const modified = URI.file('/repo/book.md');
		const serializer = new TestDiffSerializer();
		const unnamed = store.add(new TestDiffInput(original, modified, undefined));
		const named = store.add(new TestDiffInput(original, modified, 'book.md (Working Tree)'));
		const saved = [serializer.serialize(unnamed), serializer.serialize(named)];
		const earlier = JSON.stringify({ original: original.toString(), modified: modified.toString(), label: unnamed.getName() });
		const restored = [...saved, earlier].map(text => serializer.deserialize(undefined as unknown as IInstantiationService, text!) as TestDiffInput);
		serializer.created.forEach(input => store.add(input));
		deepStrictEqual({
			saved: saved.map(text => JSON.parse(text!).label),
			restored: restored.map(input => input.label),
			matches: restored[0].matches(unnamed),
		}, {
			saved: [undefined, 'book.md (Working Tree)'],
			restored: [undefined, 'book.md (Working Tree)', undefined],
			matches: true,
		});
	});
});
