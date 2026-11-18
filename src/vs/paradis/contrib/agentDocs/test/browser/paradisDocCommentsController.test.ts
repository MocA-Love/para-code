/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event as BaseEvent } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOverlayWebview, WebviewMessageReceivedEvent } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { IParadisDocCommentsBackend } from '../../browser/paradisDocCommentsBackend.js';
import { ParadisDocCommentsController } from '../../browser/paradisDocCommentsController.js';
import { IParadisDocCommentDraft, IParadisDocCommentThread } from '../../common/paradisDocComments.js';

suite('ParadisDocCommentsController', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initial: IParadisDocCommentThread[] = []) {
		const added: { hostId: string; path: string; draft: IParadisDocCommentDraft }[] = [];
		const acts: unknown[][] = [];
		const threads: IParadisDocCommentThread[] = [...initial];
		const backend: IParadisDocCommentsBackend = {
			onDidChange: BaseEvent.None,
			get: async (hostId, path) => ({ hostId, path, threads: [...threads] }),
			add: async (hostId, path, draft) => {
				added.push({ hostId, path, draft });
				const thread: IParadisDocCommentThread = { id: `c-00000000000${added.length}`, startedBy: 'user', anchor: draft.anchor, state: 'queued', messages: [{ by: 'user', text: draft.text, at: 1 }], createdAt: added.length };
				threads.push(thread);
				return thread;
			},
			setPlaces: async () => { },
			act: async (_hostId, _path, id, action, text) => { acts.push([id, action, text]); },
		};
		const messages = disposables.add(new Emitter<WebviewMessageReceivedEvent>());
		const posted: unknown[] = [];
		const webview = { onMessage: messages.event, postMessage: async (message: unknown) => { posted.push(message); return true; }, isFocused: false } as unknown as IOverlayWebview;
		const opened: string[] = [];
		const controller = disposables.add(new ParadisDocCommentsController({ webview: () => webview, openLink: link => opened.push(link), recordScroll: () => { } }, backend));
		const toolbar = mainWindow.document.createElement('div');
		const content = mainWindow.document.createElement('div');
		mainWindow.document.body.append(toolbar, content);
		disposables.add({ dispose: () => { toolbar.remove(); content.remove(); } });
		controller.createToolbarToggle(toolbar);
		controller.createColumn(content);
		controller.setResource(URI.file('/w/note.md'));
		const store = disposables.add(new DisposableStore());
		controller.attach(webview, store);
		const send = (message: object) => messages.fire({ message: { ...message, token: controller.token } } as WebviewMessageReceivedEvent);
		return { controller, added, acts, posted, opened, content, send, messages };
	}

	const flush = () => new Promise(resolve => setTimeout(resolve, 0));

	test('a message from the preview never saves a comment; it only opens an empty box with the quote', async () => {
		const { added, content, send, messages } = setup();
		await flush();
		// 印の無いもの・本文を運ぼうとするもの
		messages.fire({ message: { __paradisDocComment: 'compose', anchor: { quote: 'A' } } } as WebviewMessageReceivedEvent);
		send({ __paradisDocComment: 'add', anchor: { quote: 'A' }, body: 'forged' });
		send({ __paradisDocComment: 'save', text: 'forged' });
		const before = content.querySelector('textarea');
		send({ __paradisDocComment: 'compose', anchor: { quote: '結果は 5 分間キャッシュします' }, text: 'forged', body: 'forged' });
		await flush();
		const textarea = content.querySelector('textarea');
		assert.deepStrictEqual({
			added: added.length,
			boxBefore: before !== null,
			box: textarea?.value,
			quote: content.querySelector('.paradis-doc-comment-quote')?.textContent,
			open: content.classList.contains('paradis-doc-comments-open'),
		}, { added: 0, boxBefore: false, box: '', quote: '「結果は 5 分間キャッシュします」', open: true });
	});

	test('saves what was typed in the box, and a second request from the page does not replace a box with text', async () => {
		const { added, content, send } = setup();
		await flush();
		send({ __paradisDocComment: 'compose', anchor: { quote: 'A', before: 'x', after: 'y' } });
		const textarea = content.querySelector('textarea')!;
		textarea.value = '根拠は?';
		textarea.dispatchEvent(new Event('input'));
		send({ __paradisDocComment: 'compose', anchor: { quote: 'B' } });
		const quoteWhileTyping = content.querySelector('.paradis-doc-comment-quote')?.textContent;
		content.querySelector<HTMLElement>('.paradis-doc-comment-footer .paradis-button-primary')!.click();
		await flush();
		await flush();
		assert.deepStrictEqual({
			quoteWhileTyping,
			added,
			box: content.querySelector('textarea'),
			cards: [...content.querySelectorAll('.paradis-doc-comment-card')].map(card => card.querySelector('.paradis-doc-comment-text')?.textContent),
		}, {
			quoteWhileTyping: '「A」',
			added: [{ hostId: '', path: '/w/note.md', draft: { anchor: { quote: 'A', before: 'x', after: 'y' }, text: '根拠は?' } }],
			box: null,
			cards: ['根拠は?'],
		});
	});

	test('a new request replaces the quote of an empty box', async () => {
		const { added, content, send } = setup();
		await flush();
		send({ __paradisDocComment: 'compose', anchor: { quote: 'A' } });
		send({ __paradisDocComment: 'compose', anchor: { quote: 'B' } });
		const textarea = content.querySelector('textarea')!;
		textarea.value = 'x';
		textarea.dispatchEvent(new Event('input'));
		content.querySelector<HTMLElement>('.paradis-doc-comment-footer .paradis-button-primary')!.click();
		await flush();
		await flush();
		assert.deepStrictEqual({ boxes: content.querySelectorAll('textarea').length, added: added.map(item => item.draft) }, { boxes: 0, added: [{ anchor: { quote: 'B' }, text: 'x' }] });
	});

	test('does not show the layer for a file that is not a document, nor without a place to save', () => {
		const { controller } = setup();
		controller.setResource(URI.file('/w/data.json'));
		const withoutBackend = disposables.add(new ParadisDocCommentsController({ webview: () => undefined, openLink: () => { }, recordScroll: () => { } }, undefined));
		withoutBackend.setResource(URI.file('/w/note.md'));
		assert.deepStrictEqual([controller.enabled, withoutBackend.enabled], [false, false]);
	});

	test('shows the delivery state and the answer as plain text in the card, and sends the actions of the card through the window', async () => {
		const answered: IParadisDocCommentThread = {
			id: 'c-000000000001', startedBy: 'user', anchor: { quote: 'A' }, state: 'answered', createdAt: 1,
			messages: [{ by: 'user', text: '根拠は?', at: 1 }, { by: 'agent', text: '<b>出典</b>を足しました。', at: 2, edits: [{ at: 2, tool: 'Edit' }] }],
		};
		const waiting: IParadisDocCommentThread = {
			id: 'c-000000000002', startedBy: 'user', anchor: { quote: 'B' }, state: 'queued', createdAt: 2,
			messages: [{ by: 'user', text: '別件', at: 2 }], delivery: { attempts: 0, blockedBy: 'draftUnknown' },
		};
		const { acts, content } = setup([answered, waiting]);
		await flush();
		const cards = [...content.querySelectorAll<HTMLElement>('.paradis-doc-comment-card')];
		const summary = cards.map(card => ({
			status: card.querySelector('.paradis-status-label')?.textContent,
			answer: card.querySelector('.paradis-doc-comment-answer .paradis-doc-comment-text')?.innerHTML,
			buttons: [...card.querySelectorAll('.paradis-doc-comment-footer .paradis-button')].map(button => button.textContent),
		}));
		const button = (card: HTMLElement, label: string) => [...card.querySelectorAll<HTMLElement>('.paradis-doc-comment-footer .paradis-button')].find(candidate => candidate.textContent === label)!;
		button(cards[0], '今すぐ届ける').click();
		button(cards[1], '解決にする').click();
		button(cards[1], '返信').click();
		const reply = content.querySelector<HTMLTextAreaElement>('.paradis-doc-comment-reply textarea')!;
		reply.value = ' 脚注の番号は? ';
		reply.dispatchEvent(new Event('input'));
		content.querySelector<HTMLElement>('.paradis-doc-comment-reply .paradis-button-primary')!.click();
		await flush();
		assert.deepStrictEqual({ summary, acts, replyOpen: content.querySelector('.paradis-doc-comment-reply') !== null }, {
			summary: [
				{ status: '届け待ち', answer: undefined, buttons: ['今すぐ届ける', '返信', '解決にする'] },
				{ status: '回答あり', answer: '&lt;b&gt;出典&lt;/b&gt;を足しました。', buttons: ['返信', '解決にする'] },
			],
			acts: [['c-000000000002', 'deliverNow', undefined], ['c-000000000001', 'resolve', undefined], ['c-000000000001', 'append', '脚注の番号は?']],
			replyOpen: false,
		});
	});
});
