/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDocDeliveryInput, IParadisDocWakeInput, paradisDecideDocDelivery, paradisDecideDocWake, paradisDocDeliveryFirstLine, paradisDocDeliveryMayEnter, paradisDocDeliveryPromptMatches, paradisDocDeliveryText, paradisDocWakeSpaceFor } from '../../common/paradisDocCommentDelivery.js';
import {
	IParadisDocCommentThread,
	paradisCountOpenDocComments,
	paradisDocCommentAwaitsDelivery,
	paradisDocCommentReplySince,
	paradisParseDocCommentSidecar,
	paradisSerializeDocCommentSidecar,
	paradisWithDocCommentBlocked,
	paradisWithDocCommentDelivered,
	paradisWithDocCommentReply,
	paradisWithDocCommentTyped,
	paradisWithDocCommentUserAction,
} from '../../common/paradisDocComments.js';

const READY: IParadisDocDeliveryInput = { owner: 'live', hasHooks: true, status: undefined, unconfirmedRelease: undefined, draft: 'empty', turnJustEnded: false, forced: false, remote: false, busy: false };

const THREAD: IParadisDocCommentThread = {
	id: 'c-0123456789ab',
	startedBy: 'user',
	anchor: { quote: '結果は 5 分間キャッシュします' },
	state: 'queued',
	messages: [{ by: 'user', text: '5 分の根拠は?', at: 10 }],
	createdAt: 10,
};

suite('Paradis doc comments: delivery rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('never types into a pane that waits for a permission or a question, works, or has a draft; waits for the end of a turn when the draft is unknown', () => {
		const decide = (input: Partial<IParadisDocDeliveryInput>) => paradisDecideDocDelivery({ ...READY, ...input });
		assert.deepStrictEqual({
			ready: decide({}),
			review: decide({ status: 'review' }),
			permission: decide({ status: 'permission' }),
			question: decide({ status: 'question', draft: 'unknown', forced: true }),
			working: decide({ status: 'working' }),
			busy: decide({ busy: true }),
			draft: decide({ draft: 'text' }),
			draftForced: decide({ draft: 'text', forced: true }),
			unknownDraft: decide({ draft: 'unknown' }),
			unknownDraftAfterTurn: decide({ draft: 'unknown', turnJustEnded: true }),
			unknownDraftForced: decide({ draft: 'unknown', forced: true }),
			remote: decide({ remote: true }),
			unconfirmed: decide({ unconfirmedRelease: 'pending' }),
			noHooks: decide({ hasHooks: false, status: undefined }),
			noOwner: decide({ owner: 'none' }),
			ended: decide({ owner: 'ended' }),
			unknown: decide({ owner: 'unknown' }),
		}, {
			ready: { kind: 'deliver', enter: true },
			review: { kind: 'deliver', enter: true },
			permission: { kind: 'wait', block: 'permission' },
			question: { kind: 'wait', block: 'question' },
			working: { kind: 'wait', block: 'working' },
			busy: { kind: 'wait', block: 'sending' },
			draft: { kind: 'wait', block: 'draft' },
			draftForced: { kind: 'wait', block: 'draft' },
			unknownDraft: { kind: 'wait', block: 'draftUnknown' },
			unknownDraftAfterTurn: { kind: 'deliver', enter: true },
			unknownDraftForced: { kind: 'deliver', enter: true },
			remote: { kind: 'deliver', enter: false },
			unconfirmed: { kind: 'deliver', enter: false },
			noHooks: { kind: 'undeliverable', block: 'noHooks' },
			noOwner: { kind: 'undeliverable', block: 'noOwner' },
			ended: { kind: 'undeliverable', block: 'ended' },
			unknown: { kind: 'undeliverable', block: 'unknown' },
		});
	});

	test('waits while the owner is being woken and for the start of a woken CLI, but never over a permission', () => {
		const decide = (input: Partial<IParadisDocDeliveryInput>) => paradisDecideDocDelivery({ ...READY, ...input });
		assert.deepStrictEqual([
			decide({ owner: 'waking' }),
			decide({ starting: true, draft: 'unknown', turnJustEnded: true }),
			decide({ starting: true, status: 'permission' }),
			decide({ starting: false, draft: 'unknown', turnJustEnded: true }),
		], [
			{ kind: 'wait', block: 'waking' },
			{ kind: 'wait', block: 'waking' },
			{ kind: 'wait', block: 'permission' },
			{ kind: 'deliver', enter: true },
		]);
	});

	test('wakes only a session that was seen ending, nowhere alive, not being woken, on this machine, with a known folder', () => {
		const owner = { agent: 'claude', session: 's1', cwd: '/repo/sub', ended: 5 };
		const base: IParadisDocWakeInput = { owner, live: false, waking: false, seenUnverified: false, hostId: '', windowIsRemote: false };
		const wake = (input: Partial<IParadisDocWakeInput>) => paradisDecideDocWake({ ...base, ...input });
		const reason = (input: Partial<IParadisDocWakeInput>) => {
			const answer = wake(input);
			return answer.kind === 'refused' ? answer.reason : answer.kind;
		};
		assert.deepStrictEqual({
			ticket: wake({}),
			codex: reason({ owner: { ...owner, agent: 'codex' } }),
			noOwner: reason({ owner: undefined }),
			live: reason({ live: true }),
			waking: reason({ waking: true }),
			unknown: reason({ owner: { ...owner, ended: undefined } }),
			maybeLive: reason({ seenUnverified: true }),
			agent: reason({ owner: { ...owner, agent: 'opencode' } }),
			remoteDoc: reason({ hostId: 'devbox' }),
			remoteWindow: reason({ windowIsRemote: true }),
			noCwd: reason({ owner: { ...owner, cwd: undefined } }),
		}, {
			ticket: { kind: 'wake', agent: 'claude', session: 's1', cwd: '/repo/sub' },
			codex: 'wake',
			noOwner: 'noOwner',
			live: 'live',
			waking: 'waking',
			unknown: 'unknown',
			maybeLive: 'maybeLive',
			agent: 'agent',
			remoteDoc: 'remote',
			remoteWindow: 'remote',
			noCwd: 'noCwd',
		});
	});

	test('wakes in the deepest space that holds the folder where the session started', () => {
		const spaces = [{ stateKey: 'repo', path: '/repo' }, { stateKey: 'wt', path: '/repo/.worktrees/a' }, { stateKey: 'other', path: '/repo2' }];
		assert.deepStrictEqual([
			paradisDocWakeSpaceFor(spaces, '/repo/.worktrees/a/src')?.stateKey,
			paradisDocWakeSpaceFor(spaces, '/repo/src')?.stateKey,
			paradisDocWakeSpaceFor(spaces, '/repo2')?.stateKey,
			paradisDocWakeSpaceFor(spaces, '/elsewhere')?.stateKey,
		], ['wt', 'repo', 'other', undefined]);
	});

	test('checks again before Enter: the state, and that the input holds only what was typed', () => {
		const typed = '[Para Code] x';
		assert.deepStrictEqual({
			idle: paradisDocDeliveryMayEnter(undefined, undefined, typed, typed),
			unknownDraft: paradisDocDeliveryMayEnter('review', undefined, undefined, typed),
			permission: paradisDocDeliveryMayEnter('permission', undefined, typed, typed),
			working: paradisDocDeliveryMayEnter('working', undefined, typed, typed),
			unconfirmed: paradisDocDeliveryMayEnter(undefined, 'unverifiable', typed, typed),
			joined: paradisDocDeliveryMayEnter(undefined, undefined, `hello ${typed}`, typed),
			notYetReported: paradisDocDeliveryMayEnter(undefined, undefined, '', typed),
		}, { idle: true, unknownDraft: true, permission: false, working: false, unconfirmed: false, joined: false, notYetReported: true });
	});

	test('types one line: the ID and the first line of what the user wrote (200 characters, no control characters), only IDs for several', () => {
		const long = 'あ'.repeat(250);
		assert.deepStrictEqual({
			one: paradisDocDeliveryText('report.html', [{ id: 'c-7f3a2k00', text: '\n この数字の根拠は？\x1b[201~\n出典を足してほしい' }]),
			many: paradisDocDeliveryText('report.html', [{ id: 'c-7f3a2k00', text: 'a' }, { id: 'c-81b2qd00', text: 'b' }]),
			long: paradisDocDeliveryFirstLine(long).length,
			lineBreaks: /[\r\n]/.test(paradisDocDeliveryText('a\nb.md', [{ id: 'c-7f3a2k00', text: 'x\u2028y' }])),
		}, {
			one: '[Para Code 資料のコメント] report.html に 1 件（ID: c-7f3a2k00）: 「この数字の根拠は？ [201~」 para-browser の read_doc_comments で引用と位置を読み、対応したら reply_doc_comment で回答してください。',
			many: '[Para Code 資料のコメント] report.html に 2 件（ID: c-7f3a2k00, c-81b2qd00）。para-browser の read_doc_comments で読み、1 件ずつ対応して reply_doc_comment で回答してください。',
			long: 200,
			lineBreaks: false,
		});
	});

	test('a submitted prompt is ours when it carries one of the IDs', () => {
		assert.deepStrictEqual([
			paradisDocDeliveryPromptMatches('[Para Code 資料のコメント] … c-7f3a2k00 …', ['c-7f3a2k00']),
			paradisDocDeliveryPromptMatches('別の指示', ['c-7f3a2k00']),
			paradisDocDeliveryPromptMatches(undefined, ['c-7f3a2k00']),
		], [true, false, true]);
	});
});

suite('Paradis doc comments: states', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('goes queued → typed → delivered → answered → resolved, and a reply in the user\'s words queues it again', () => {
		const blocked = paradisWithDocCommentBlocked(THREAD, 'permission');
		const undeliverable = paradisWithDocCommentBlocked(THREAD, 'noHooks');
		const typed = paradisWithDocCommentTyped(blocked, 20, true);
		const delivered = paradisWithDocCommentDelivered(typed, 25);
		const answered = paradisWithDocCommentReply(delivered, '出典を足しました。', false, [{ at: 22, tool: 'Edit' }], 30);
		const resolved = paradisWithDocCommentUserAction(answered, 'resolve', undefined, 40);
		const reopened = paradisWithDocCommentUserAction(resolved, 'reopen', undefined, 50);
		const appended = paradisWithDocCommentUserAction(answered, 'append', ' 脚注の番号は? ', 60);
		assert.deepStrictEqual({
			blocked: [blocked.state, blocked.delivery],
			undeliverable: [undeliverable.state, undeliverable.delivery],
			typed: [typed.state, typed.delivery, paradisDocCommentAwaitsDelivery(typed), paradisWithDocCommentBlocked(typed, 'working') === typed],
			delivered: [delivered.state, delivered.delivery],
			answered: [answered.state, answered.messages[1], paradisDocCommentReplySince(answered)],
			resolved: resolved.state,
			reopened: reopened.state,
			appended: [appended.state, appended.messages.map(message => message.text), appended.delivery, paradisDocCommentAwaitsDelivery(appended)],
			// 追記を貼り終えた後に解決・開き直すと届いたへ戻す（同じ文を二度貼らない）。貼る前なら届け直す
			reopenSent: paradisWithDocCommentUserAction(paradisWithDocCommentUserAction(paradisWithDocCommentTyped(appended, 70, true), 'resolve', undefined, 80), 'reopen', undefined, 90).state,
			reopenUnsent: paradisWithDocCommentUserAction(paradisWithDocCommentUserAction(appended, 'resolve', undefined, 80), 'reopen', undefined, 90).state,
			open: paradisCountOpenDocComments([THREAD, undeliverable, delivered, answered, resolved]),
			sinceDelivered: paradisDocCommentReplySince(delivered),
		}, {
			blocked: ['queued', { attempts: 0, blockedBy: 'permission' }],
			undeliverable: ['undeliverable', { attempts: 0, blockedBy: 'noHooks' }],
			typed: ['queued', { attempts: 1, typedAt: 20, entered: true }, false, true],
			delivered: ['delivered', { attempts: 1, typedAt: 20, entered: true, deliveredAt: 25 }],
			answered: ['answered', { by: 'agent', text: '出典を足しました。', at: 30, edits: [{ at: 22, tool: 'Edit' }] }, 30],
			resolved: 'resolved',
			reopened: 'answered',
			appended: ['queued', ['5 分の根拠は?', '出典を足しました。', '脚注の番号は?'], { attempts: 1 }, true],
			reopenSent: 'delivered',
			reopenUnsent: 'queued',
			open: 3,
			sinceDelivered: 25,
		});
	});

	test('keeps the delivery and the edits when the sidecar is read back', () => {
		const answered = paradisWithDocCommentReply(paradisWithDocCommentDelivered(paradisWithDocCommentTyped(THREAD, 20, false), 25), '済み', true, [{ at: 22, tool: 'Edit', toolUseId: 'tu-1' }], 30);
		const sidecar = { hostId: '', path: '/w/a.md', threads: [answered, paradisWithDocCommentBlocked({ ...THREAD, id: 'c-0123456789ac' }, 'draftUnknown')] };
		assert.deepStrictEqual(paradisParseDocCommentSidecar(paradisSerializeDocCommentSidecar(sidecar), '', '/w/a.md'), sidecar);
	});
});
