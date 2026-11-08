/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILocalTranscriptionService } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { ChatDictationSurface, ChatSpeechToTextState, IChatDictationTranscript, IChatSpeechToTextService } from '../../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { INativeWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/electron-browser/environmentService.js';
import { ParadisAgentChatDictation, paradisAgentChatShowsMicrophone } from '../../electron-browser/paradisAgentChatDictation.js';

suite('Paradis agent chat dictation', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let container: HTMLElement;

	setup(() => {
		container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
	});

	teardown(() => container.remove());

	function create(supported: boolean) {
		const stateEmitter = disposables.add(new Emitter<ChatSpeechToTextState>());
		const transcriptEmitter = disposables.add(new Emitter<IChatDictationTranscript>());
		const surfaces: (ChatDictationSurface | undefined)[] = [];
		let state = ChatSpeechToTextState.Idle;
		let finalText: string | undefined;
		const setState = (value: ChatSpeechToTextState) => {
			state = value;
			stateEmitter.fire(value);
		};
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IChatSpeechToTextService, {
			onDidChangeState: stateEmitter.event,
			onDidUpdateTranscript: transcriptEmitter.event,
			get state() { return state; },
			get isBusy() { return state !== ChatSpeechToTextState.Idle; },
			start: async (_window: Window & typeof globalThis, surface?: ChatDictationSurface) => {
				surfaces.push(surface);
				setState(ChatSpeechToTextState.Recording);
			},
			stopAndTranscribe: async () => {
				setState(ChatSpeechToTextState.Idle);
				return finalText;
			},
		});
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IHoverService, NullHoverService);
		instantiationService.stub(ILocalTranscriptionService, { isSupported: supported });
		instantiationService.stub(INativeWorkbenchEnvironmentService, { os: { release: '24.6.0', hostname: 'test', arch: 'arm64' } });
		const textarea = mainWindow.document.createElement('textarea');
		container.appendChild(textarea);
		const notices: (string | undefined)[] = [];
		let edits = 0;
		const dictation = disposables.add(instantiationService.createInstance(ParadisAgentChatDictation, {
			container,
			textarea,
			didEdit: () => { edits++; },
			showNotice: message => { notices.push(message); },
		}));
		const button = container.querySelector('button.paradis-agent-chat-mic') as HTMLButtonElement;
		const click = async () => {
			button.click();
			await new Promise(resolve => setTimeout(resolve, 0));
		};
		return {
			dictation, textarea, button, click, notices, surfaces,
			transcript: (text: string) => transcriptEmitter.fire({ text, finalizedText: '' }),
			setFinal: (text: string) => { finalText = text; },
			edits: () => edits,
		};
	}

	test('writes the transcript at the caret while recording and the final text after stopping', async () => {
		const chat = create(true);
		chat.textarea.value = '前置き。後ろ';
		chat.textarea.setSelectionRange(4, 4);
		await chat.click();
		chat.transcript('こんに');
		chat.transcript('こんにちは');
		const whileRecording = { value: chat.textarea.value, active: chat.button.classList.contains('active') };
		chat.setFinal('こんにちは。');
		await chat.click();
		assert.deepStrictEqual({
			whileRecording,
			value: chat.textarea.value,
			active: chat.button.classList.contains('active'),
			surfaces: chat.surfaces,
			edits: chat.edits(),
		}, {
			whileRecording: { value: '前置き。こんにちは後ろ', active: true },
			value: '前置き。こんにちは。後ろ',
			active: false,
			// 'chat' だと upstream の Copilot のチャットのマイクが光る
			surfaces: ['editor'],
			edits: 3,
		});
	});

	test('keeps what the user typed during dictation and continues at the caret', async () => {
		const chat = create(true);
		await chat.click();
		chat.transcript('一つ目');
		chat.textarea.value += '、';
		chat.textarea.setSelectionRange(chat.textarea.value.length, chat.textarea.value.length);
		chat.textarea.dispatchEvent(new Event('input'));
		chat.transcript('一つ目二つ目');
		chat.dictation.detach();
		chat.transcript('一つ目二つ目三つ目');
		assert.strictEqual(chat.textarea.value, '一つ目、二つ目');
	});

	test('explains why dictation is unavailable instead of starting it', async () => {
		const chat = create(false);
		await chat.click();
		assert.deepStrictEqual({ surfaces: chat.surfaces, noticed: chat.notices.length === 1 && typeof chat.notices[0] === 'string', unavailable: chat.button.classList.contains('unavailable') }, { surfaces: [], noticed: true, unavailable: true });
	});

	test('hides the microphone only for people who turned dictation off themselves', () => {
		assert.deepStrictEqual([
			paradisAgentChatShowsMicrophone({ value: true }, false),
			paradisAgentChatShowsMicrophone({ value: false }, false),
			// Windows・Linux は Para が既定を false にしている。案内のためにマイクは出す
			paradisAgentChatShowsMicrophone({ value: false }, true),
			paradisAgentChatShowsMicrophone({ value: false, userValue: false }, true),
			paradisAgentChatShowsMicrophone({ value: false, policyValue: false }, true),
		], [true, false, true, false, false]);
	});
});
