/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD, paradisShouldClearAgentStatusAfterPollFailures, paradisShouldSweepStaleWorkingStatus } from '../../common/paradisAgentStatusStale.js';
import { clearParadisAgentPaneActivity, fireParadisAgentHookEvent, getParadisAgentPaneActivity, IParadisAgentHookEvent, onParadisAgentHookEvent, onParadisAgentPaneActivity, paradisSanitizeAgentHookPayload, registerParadisAgentPaneActivityGuard, setParadisAgentPaneActivity } from '../../node/paradisAgentHookBus.js';

suite('ParadisAgentBrowserStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not complete a normal long-running tool', () => {
		assert.strictEqual(paradisShouldSweepStaleWorkingStatus('working', false, 0, 16 * 60 * 1000), false);
	});

	test('completes only a stale Stop background-task fallback', () => {
		assert.deepStrictEqual({
			beforeTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000),
			afterTimeout: paradisShouldSweepStaleWorkingStatus('working', true, 0, 15 * 60 * 1000 + 1),
			review: paradisShouldSweepStaleWorkingStatus('review', true, 0, 16 * 60 * 1000),
		}, { beforeTimeout: false, afterTimeout: true, review: false });
	});

	test('clears renderer status only after sustained shared-process poll failure', () => {
		assert.strictEqual(paradisShouldClearAgentStatusAfterPollFailures(PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD - 1), false);
		assert.strictEqual(paradisShouldClearAgentStatusAfterPollFailures(PARADIS_AGENT_STATUS_POLL_FAILURE_CLEAR_THRESHOLD), true);
	});

	test('clears transcript activity when its pane is retired', () => {
		const guard = registerParadisAgentPaneActivityGuard(token => token === 'retired-pane');
		try {
			setParadisAgentPaneActivity('retired-pane', { backgroundTasks: new Map([['task-1', 1]]), pendingQuestion: true, pendingApproval: true });
			assert.strictEqual(getParadisAgentPaneActivity('retired-pane').backgroundTasks.size, 1);
			clearParadisAgentPaneActivity('retired-pane');
			assert.strictEqual(getParadisAgentPaneActivity('retired-pane').backgroundTasks.size, 0);
			assert.strictEqual(getParadisAgentPaneActivity('retired-pane').pendingQuestion, false);
			assert.strictEqual(getParadisAgentPaneActivity('retired-pane').pendingApproval, false);
		} finally {
			guard.dispose();
			clearParadisAgentPaneActivity('retired-pane');
		}
	});

	test('guards transcript activity before singleton state materialization while cleanup bypasses the guard', () => {
		clearParadisAgentPaneActivity('allowed-pane');
		clearParadisAgentPaneActivity('denied-pane');
		const guard = registerParadisAgentPaneActivityGuard(token => token === 'allowed-pane');
		try {
			setParadisAgentPaneActivity('denied-pane', { backgroundTasks: new Map([['task', 1]]), pendingQuestion: true, pendingApproval: false });
			assert.strictEqual(getParadisAgentPaneActivity('denied-pane').backgroundTasks.size, 0);
			setParadisAgentPaneActivity('allowed-pane', { backgroundTasks: new Map([['task', 1]]), pendingQuestion: true, pendingApproval: false });
			assert.strictEqual(getParadisAgentPaneActivity('allowed-pane').backgroundTasks.size, 1);
			clearParadisAgentPaneActivity('allowed-pane');
			assert.strictEqual(getParadisAgentPaneActivity('allowed-pane').backgroundTasks.size, 0);
		} finally {
			guard.dispose();
			clearParadisAgentPaneActivity('allowed-pane');
			clearParadisAgentPaneActivity('denied-pane');
		}
	});

	test('denies transcript activity until an owner guard is installed', () => {
		clearParadisAgentPaneActivity('unguarded-pane');
		setParadisAgentPaneActivity('unguarded-pane', {
			backgroundTasks: new Map([['task', 1]]),
			pendingQuestion: true,
			pendingApproval: true,
		});
		assert.deepStrictEqual(getParadisAgentPaneActivity('unguarded-pane'), {
			backgroundTasks: new Map(),
			pendingQuestion: false,
			pendingApproval: false,
		});
	});

	test('copy-owns and bounds accepted transcript activity', () => {
		clearParadisAgentPaneActivity('owned-pane');
		const guard = registerParadisAgentPaneActivityGuard(token => token === 'owned-pane');
		try {
			const backgroundTasks = new Map<string, number>();
			for (let index = 0; index < 10_000; index++) {
				backgroundTasks.set(`task-${index}`, index);
			}
			setParadisAgentPaneActivity('owned-pane', {
				backgroundTasks,
				pendingQuestion: true,
				pendingApproval: false,
			});
			backgroundTasks.clear();

			const first = getParadisAgentPaneActivity('owned-pane');
			assert.strictEqual(first.backgroundTasks.size, 4_096);
			(first.backgroundTasks as Map<string, number>).clear();
			const second = getParadisAgentPaneActivity('owned-pane');
			assert.strictEqual(second.backgroundTasks.size, 4_096);
			assert.strictEqual(second.pendingQuestion, true);
		} finally {
			guard.dispose();
			clearParadisAgentPaneActivity('owned-pane');
		}
	});

	test('isolates pane activity mutations between subscribers and retained state', () => {
		clearParadisAgentPaneActivity('subscriber-pane');
		const guard = registerParadisAgentPaneActivityGuard(token => token === 'subscriber-pane');
		const mutator = onParadisAgentPaneActivity(({ activity }) => {
			(activity.backgroundTasks as Map<string, number>).clear();
			Reflect.set(activity, 'pendingQuestion', false);
		});
		let observed: ReturnType<typeof getParadisAgentPaneActivity> | undefined;
		const observer = onParadisAgentPaneActivity(event => observed = event.activity);
		try {
			setParadisAgentPaneActivity('subscriber-pane', {
				backgroundTasks: new Map([['task-1', Date.now()]]),
				pendingQuestion: true,
				pendingApproval: false,
			});

			assert.strictEqual(observed?.backgroundTasks.size, 1);
			assert.strictEqual(observed?.pendingQuestion, true);
			assert.strictEqual(getParadisAgentPaneActivity('subscriber-pane').backgroundTasks.size, 1);
		} finally {
			observer.dispose();
			mutator.dispose();
			guard.dispose();
			clearParadisAgentPaneActivity('subscriber-pane');
		}
	});

	test('accepts only nonnegative safe integer background task timestamps within future skew', () => {
		clearParadisAgentPaneActivity('timestamp-pane');
		const guard = registerParadisAgentPaneActivityGuard(token => token === 'timestamp-pane');
		try {
			const now = Date.now();
			setParadisAgentPaneActivity('timestamp-pane', {
				backgroundTasks: new Map([
					['negative', -1],
					['fractional', now + 0.5],
					['unsafe', Number.MAX_SAFE_INTEGER + 1],
					['far-future', now + 60 * 60 * 1000],
					['epoch', 0],
					['current', now],
					['near-future', now + 60 * 1000],
				]),
				pendingQuestion: false,
				pendingApproval: false,
			});

			assert.deepStrictEqual(
				[...getParadisAgentPaneActivity('timestamp-pane').backgroundTasks.keys()],
				['epoch', 'current', 'near-future'],
			);
		} finally {
			guard.dispose();
			clearParadisAgentPaneActivity('timestamp-pane');
		}
	});

	test('fails closed when the transcript activity guard throws', () => {
		clearParadisAgentPaneActivity('throwing-pane');
		const guard = registerParadisAgentPaneActivityGuard(() => { throw new Error('guard failed'); });
		try {
			assert.doesNotThrow(() => setParadisAgentPaneActivity('throwing-pane', {
				backgroundTasks: new Map([['task', 1]]), pendingQuestion: true, pendingApproval: false,
			}));
			assert.strictEqual(getParadisAgentPaneActivity('throwing-pane').backgroundTasks.size, 0);
		} finally {
			guard.dispose();
			clearParadisAgentPaneActivity('throwing-pane');
		}
	});

	test('sanitizes hook payload without dropping event-specific fields', () => {
		assert.deepStrictEqual(paradisSanitizeAgentHookPayload({
			agent_id: 'agent-1', task_id: 'task-1', nested: { values: [1, true, 'ok'] }, ignored: undefined,
		}), { agent_id: 'agent-1', task_id: 'task-1', nested: { values: [1, true, 'ok'] } });
	});

	test('bounds hook payload depth and string size', () => {
		let deep: unknown = { bottom: true };
		for (let i = 0; i < 25; i++) {
			deep = { nest: deep };
		}
		const result = paradisSanitizeAgentHookPayload({
			value: 'x'.repeat(20_000),
			deep,
		});
		assert.ok(typeof result?.['value'] === 'string' && result['value'].length < 20_000);
		let cursor = result?.['deep'] as Record<string, unknown> | undefined;
		let depth = 1;
		while (cursor !== undefined && cursor['nest'] !== undefined) {
			cursor = cursor['nest'] as Record<string, unknown>;
			depth++;
		}
		assert.ok(depth < 25, `depth must be bounded, got ${depth}`);
		assert.deepStrictEqual(cursor, {});
	});

	test('keeps AskUserQuestion option labels through payload sanitization', () => {
		// 選択肢は payload ルートから深さ6（tool_input.questions[i].options[i].label）にある。
		// 深さ上限がこれを下回るとモバイルの質問カードが選択肢なしになる（実際に起きた退行）。
		const result = paradisSanitizeAgentHookPayload({
			session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
			tool_input: {
				questions: [{
					question: 'どうしますか？', header: '方針', multiSelect: false,
					options: [{ label: 'A案', description: '説明A' }, { label: 'B案' }],
				}],
			},
		});
		assert.deepStrictEqual(result?.['tool_input'], {
			questions: [{
				question: 'どうしますか？', header: '方針', multiSelect: false,
				options: [{ label: 'A案', description: '説明A' }, { label: 'B案' }],
			}],
		});
	});

	test('drops prototype mutation keys from hook payloads', () => {
		const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":true}');
		assert.deepStrictEqual(paradisSanitizeAgentHookPayload(payload), { safe: true });
	});

	test('recursively freezes sanitized hook payload objects and arrays', () => {
		const payload = paradisSanitizeAgentHookPayload({ nested: { values: [{ safe: true }] } });
		const nested = payload?.['nested'] as { values: Array<{ safe: boolean }> };
		assert.strictEqual(Object.isFrozen(payload), true);
		assert.strictEqual(Object.isFrozen(nested), true);
		assert.strictEqual(Object.isFrozen(nested.values), true);
		assert.strictEqual(Object.isFrozen(nested.values[0]), true);
		assert.strictEqual(Reflect.set(nested.values[0], 'safe', false), false);
		assert.strictEqual(nested.values[0].safe, true);
	});

	test('prevents an earlier hook subscriber from changing later subscribers payload or aliases', () => {
		const observed: IParadisAgentHookEvent[] = [];
		const mutator = onParadisAgentHookEvent(event => {
			Reflect.set(event, 'sessionId', 'changed');
			const nested = event.payload?.['nested'] as { safe?: boolean } | undefined;
			if (nested) {
				Reflect.set(nested, 'safe', false);
			}
		});
		const observer = onParadisAgentHookEvent(event => observed.push(event));
		try {
			fireParadisAgentHookEvent({
				token: 'token', event: 'Stop', sessionId: 'original', transcriptPath: undefined, cwd: undefined,
				payload: { nested: { safe: true } }, at: 1,
			});
			assert.strictEqual(observed.length, 1);
			assert.strictEqual(observed[0].sessionId, 'original');
			assert.deepStrictEqual(observed[0].payload, { nested: { safe: true } });
			assert.strictEqual(Object.isFrozen(observed[0]), true);
		} finally {
			observer.dispose();
			mutator.dispose();
		}
	});
});
