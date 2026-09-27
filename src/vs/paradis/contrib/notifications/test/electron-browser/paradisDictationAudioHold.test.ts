/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { ISpeechService } from '../../../../../workbench/contrib/speech/common/speechService.js';
import { ParadisDictationAudioHold } from '../../electron-browser/paradisDictationAudioHold.contribution.js';

suite('Paradis dictation audio hold', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('follows the dictation state and releases the hold even while upstream still reports busy', () => {
		const onDidChangeState = store.add(new Emitter<ChatSpeechToTextState>());
		const onDidChangePreparingModel = store.add(new Emitter<boolean>());
		const onDidStart = store.add(new Emitter<void>());
		const onDidEnd = store.add(new Emitter<void>());
		const speechToText = {
			state: ChatSpeechToTextState.Idle,
			isPreparingModel: false,
			// upstream は停止の途中でも busy を返し、消えるときに知らせない。これを見てはいけない。
			isBusy: true,
			onDidChangeState: onDidChangeState.event,
			onDidChangePreparingModel: onDidChangePreparingModel.event,
		};
		const speech = {
			hasActiveSpeechToTextSession: false,
			onDidStartSpeechToTextSession: onDidStart.event,
			onDidEndSpeechToTextSession: onDidEnd.event,
		};
		const sent: boolean[] = [];
		const sharedProcessService = {
			getChannel: () => ({ call: async (_command: string, args: boolean[]) => { sent.push(args[0]); } }),
		} as unknown as ISharedProcessService;

		const hold = store.add(new ParadisDictationAudioHold(speechToText as unknown as IChatSpeechToTextService, speech as unknown as ISpeechService, sharedProcessService, new NullLogService()));

		speechToText.isPreparingModel = true;
		onDidChangePreparingModel.fire(true);
		speechToText.state = ChatSpeechToTextState.Recording;
		onDidChangeState.fire(speechToText.state);
		speechToText.isPreparingModel = false;
		onDidChangePreparingModel.fire(false);
		speechToText.state = ChatSpeechToTextState.Idle;
		onDidChangeState.fire(speechToText.state);
		speech.hasActiveSpeechToTextSession = true;
		onDidStart.fire();
		speech.hasActiveSpeechToTextSession = false;
		onDidEnd.fire();
		hold.dispose();

		// 起動時の false（再読み込み前の状態を解く）→ 準備開始で true → Idle で false → 拡張の音声入力で true → false
		assert.deepStrictEqual(sent, [false, true, false, true, false]);
	});
});
