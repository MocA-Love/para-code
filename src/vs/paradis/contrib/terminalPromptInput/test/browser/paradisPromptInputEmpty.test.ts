/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPromptInputSource, paradisIsAtEmptyPrompt, paradisTrackPromptInputBaseline } from '../../browser/paradisPromptInputEmpty.js';

/** 入力の始まりを 10 列目、幅 40 の端末の右端に `user@host` を出したときの `value`。 */
const RPROMPT = `${' '.repeat(21)}user@host`;

/** 右プロンプトの位置が届かない（633;H が付かない）シェル統合の偽物。 */
class FakePromptInputSource implements IParadisPromptInputSource {
	executingCommand: string | undefined = undefined;
	readonly currentCommand = { commandStartX: 10, commandRightPromptStartX: undefined, commandRightPromptEndX: undefined };
	private readonly _onDidStartInput: Emitter<void>;
	private readonly _onDidChangeInput: Emitter<{ readonly value: string; readonly cursorIndex: number }>;
	private readonly _onDidFinishInput: Emitter<void>;
	readonly promptInputModel: IParadisPromptInputSource['promptInputModel'] & { value: string; cursorIndex: number };

	constructor(store: Pick<DisposableStore, 'add'>) {
		this._onDidStartInput = store.add(new Emitter<void>());
		this._onDidChangeInput = store.add(new Emitter<{ readonly value: string; readonly cursorIndex: number }>());
		this._onDidFinishInput = store.add(new Emitter<void>());
		this.promptInputModel = {
			value: '',
			cursorIndex: 0,
			onDidStartInput: this._onDidStartInput.event,
			onDidChangeInput: this._onDidChangeInput.event,
			onDidFinishInput: this._onDidFinishInput.event,
		};
	}

	startPrompt(): void {
		this.setInput('', 0);
		this._onDidStartInput.fire();
	}

	setInput(value: string, cursorIndex: number): void {
		this.promptInputModel.value = value;
		this.promptInputModel.cursorIndex = cursorIndex;
		this._onDidChangeInput.fire({ value, cursorIndex });
	}

	finishInput(): void {
		this.promptInputModel.cursorIndex = -1;
		this._onDidFinishInput.fire();
	}
}

suite('paradisPromptInputEmpty (tracking)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('remembers the right prompt from the start of the prompt and forgets it when input ends or tracking stops', () => {
		const source = new FakePromptInputSource(store);
		const tracking = store.add(paradisTrackPromptInputBaseline(source));
		const steps: Record<string, boolean> = {};

		source.setInput(RPROMPT, 0);
		steps.beforeFirstPrompt = paradisIsAtEmptyPrompt(source);

		source.startPrompt();
		source.setInput(RPROMPT, 0);
		steps.rightPromptDrawn = paradisIsAtEmptyPrompt(source);

		source.setInput(`l${RPROMPT.substring(1)}`, 1);
		steps.typing = paradisIsAtEmptyPrompt(source);

		source.setInput(RPROMPT, 0);
		steps.erased = paradisIsAtEmptyPrompt(source);

		source.finishInput();
		source.executingCommand = 'ls';
		steps.executing = paradisIsAtEmptyPrompt(source);

		source.executingCommand = undefined;
		source.setInput(RPROMPT, 0);
		steps.afterInputEnded = paradisIsAtEmptyPrompt(source);

		source.startPrompt();
		source.setInput(RPROMPT, 0);
		steps.nextPrompt = paradisIsAtEmptyPrompt(source);

		tracking.dispose();
		steps.trackingStopped = paradisIsAtEmptyPrompt(source);

		store.add(paradisTrackPromptInputBaseline(source));
		steps.reattachedMidLine = paradisIsAtEmptyPrompt(source);

		assert.deepStrictEqual(steps, {
			beforeFirstPrompt: false,
			rightPromptDrawn: true,
			typing: false,
			erased: true,
			executing: false,
			afterInputEnded: false,
			nextPrompt: true,
			trackingStopped: false,
			reattachedMidLine: false,
		});
	});
});
