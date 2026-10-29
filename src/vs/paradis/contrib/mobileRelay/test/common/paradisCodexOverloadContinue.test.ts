/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCodexOverloadContinueHost, ParadisCodexOverloadContinue } from '../../common/paradisCodexOverloadContinue.js';

interface IFakeTimer { readonly id: number; readonly ms: number; readonly callback: () => void }

/** 時計と送り方を差し替えた host。起きたことを `log` に積む。 */
function createHost(options: { enabled?: boolean; sendAccepted?: boolean } = {}) {
	const log: string[] = [];
	const timers = new Map<number, IFakeTimer>();
	let seq = 0;
	let now = 1_000;
	const state = { enabled: options.enabled ?? true, sendAccepted: options.sendAccepted ?? true, lastRequest: undefined as { token: string; requestId: string; since: number } | undefined };
	const host: IParadisCodexOverloadContinueHost = {
		isEnabled: () => state.enabled,
		retryDelaysMs: () => [30_000, 60_000, 120_000],
		notice: (token, text) => log.push(`notice ${token}: ${text}`),
		requestSend: (token, requestId, since) => {
			log.push(`send ${token}`);
			state.lastRequest = { token, requestId, since };
			return state.sendAccepted;
		},
		notifyStopped: token => log.push(`stopped ${token}`),
		setTimeout: (callback, ms) => {
			const id = ++seq;
			timers.set(id, { id, ms, callback });
			return id;
		},
		clearTimeout: handle => { timers.delete(handle as number); },
		now: () => now,
	};
	/** 一番早い時計を進めて起こす。待っている長さを返す。 */
	const fireNext = (): number | undefined => {
		const next = [...timers.values()].sort((a, b) => a.ms - b.ms || a.id - b.id)[0];
		if (next === undefined) {
			return undefined;
		}
		timers.delete(next.id);
		now += next.ms;
		next.callback();
		return next.ms;
	};
	return { host, log, state, fireNext, pending: () => [...timers.values()].map(timer => timer.ms) };
}

suite('ParadisCodexOverloadContinue', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('waits 30, 60 and 120 seconds before each continue, and stops after three overloads in a row', () => {
		const { host, log, state, fireNext } = createHost();
		const overload = new ParadisCodexOverloadContinue(host);
		const waited: (number | undefined)[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			overload.onTurnEnded('pane', 'failed', 'server_overloaded');
			waited.push(fireNext());
			assert.strictEqual(overload.report('pane', state.lastRequest!.requestId, 'claim'), true);
			overload.onTurnStarted('pane'); // 送った continue のターン（取りやめない）
		}
		overload.onTurnEnded('pane', 'failed', 'server_overloaded');
		assert.deepStrictEqual({ waited, waiting: overload.isWaiting('pane'), log }, {
			waited: [30_000, 60_000, 120_000],
			waiting: false,
			log: [
				'notice pane: モデルが混み合っていて止まりました。30 秒後に自動で「continue」を送ります（1/3 回目）',
				'send pane',
				'notice pane: 自動で「continue」を送りました（1/3 回目）',
				'notice pane: モデルが混み合っていて止まりました。60 秒後に自動で「continue」を送ります（2/3 回目）',
				'send pane',
				'notice pane: 自動で「continue」を送りました（2/3 回目）',
				'notice pane: モデルが混み合っていて止まりました。120 秒後に自動で「continue」を送ります（3/3 回目）',
				'send pane',
				'notice pane: 自動で「continue」を送りました（3/3 回目）',
				'notice pane: 自動で 3 回続けましたが、まだ混み合っています。障害の可能性があるので、自動で続けるのをやめました',
			],
		});
		overload.dispose();
	});

	test('starts counting again after a turn that is not an overload', () => {
		const { host, state, fireNext } = createHost();
		const overload = new ParadisCodexOverloadContinue(host);
		overload.onTurnEnded('pane', 'failed', 'server_overloaded');
		fireNext();
		overload.report('pane', state.lastRequest!.requestId, 'claim');
		overload.onTurnEnded('pane', 'completed', undefined);
		overload.onTurnEnded('pane', 'failed', 'server_overloaded');
		assert.strictEqual(fireNext(), 30_000);
		overload.dispose();
	});

	test('does nothing for other errors, interruptions, or when the setting is off', () => {
		const other = createHost();
		const overload = new ParadisCodexOverloadContinue(other.host);
		overload.onTurnEnded('pane', 'failed', 'usage_limit_exceeded');
		overload.onTurnEnded('pane', 'failed', 'response_too_many_failed_attempts');
		overload.onTurnEnded('pane', 'failed', undefined);
		overload.onTurnEnded('pane', 'interrupted', undefined);
		const off = createHost({ enabled: false });
		const disabled = new ParadisCodexOverloadContinue(off.host);
		disabled.onTurnEnded('pane', 'failed', 'server_overloaded');
		assert.deepStrictEqual({ other: [other.log, other.pending()], off: [off.log, off.pending()] }, { other: [[], []], off: [[], []] });
		overload.dispose();
		disabled.dispose();
	});

	test('cancels the wait when a turn starts, the pane ends, the window saw typing, or the setting is turned off', () => {
		const started = createHost();
		const a = new ParadisCodexOverloadContinue(started.host);
		a.onTurnEnded('pane', 'failed', 'server_overloaded');
		a.onTurnStarted('pane');

		const gone = createHost();
		const b = new ParadisCodexOverloadContinue(gone.host);
		b.onTurnEnded('pane', 'failed', 'server_overloaded');
		b.forget('pane');

		const typed = createHost();
		const c = new ParadisCodexOverloadContinue(typed.host);
		c.onTurnEnded('pane', 'failed', 'server_overloaded');
		typed.fireNext();
		c.report('pane', typed.state.lastRequest!.requestId, 'typed');
		const claimAfterTyping = c.report('pane', typed.state.lastRequest!.requestId, 'claim');

		const off = createHost();
		const d = new ParadisCodexOverloadContinue(off.host);
		d.onTurnEnded('pane', 'failed', 'server_overloaded');
		off.state.enabled = false;
		off.fireNext();

		assert.deepStrictEqual({
			started: [started.log.slice(1), started.pending()],
			gone: [gone.log.slice(1), gone.pending()],
			typed: [typed.log.slice(1), claimAfterTyping],
			off: [off.log.slice(1), off.pending()],
		}, {
			started: [['notice pane: ほかの入力があったので、自動で続けるのをやめました'], []],
			gone: [[], []],
			typed: [['send pane', 'notice pane: ほかの入力があったので、自動で続けるのをやめました'], false],
			off: [[], []],
		});
		for (const overload of [a, b, c, d]) {
			overload.dispose();
		}
	});

	test('tells the user when the window cannot send, and refuses a second or stale claim', () => {
		const failed = createHost({ sendAccepted: false });
		const a = new ParadisCodexOverloadContinue(failed.host);
		a.onTurnEnded('pane', 'failed', 'server_overloaded');
		failed.fireNext();

		const unclaimed = createHost();
		const b = new ParadisCodexOverloadContinue(unclaimed.host);
		b.onTurnEnded('pane', 'failed', 'server_overloaded');
		unclaimed.fireNext();
		const deadline = unclaimed.fireNext(); // ウィンドウが引き受けないまま
		const lateClaim = b.report('pane', unclaimed.state.lastRequest!.requestId, 'claim');

		const twice = createHost();
		const c = new ParadisCodexOverloadContinue(twice.host);
		c.onTurnEnded('pane', 'failed', 'server_overloaded');
		const early = c.report('pane', 'oc-unknown', 'claim');
		twice.fireNext();
		const first = c.report('pane', twice.state.lastRequest!.requestId, 'claim');
		const second = c.report('pane', twice.state.lastRequest!.requestId, 'claim');
		c.report('pane', twice.state.lastRequest!.requestId, 'failed');

		assert.deepStrictEqual({
			failed: failed.log.slice(1),
			unclaimed: [unclaimed.log.slice(1), deadline, lateClaim],
			twice: [early, first, second, twice.log.slice(-2)],
		}, {
			failed: ['send pane', 'notice pane: PC のターミナルに送れなかったので、自動で続けるのをやめました', 'stopped pane'],
			unclaimed: [['send pane', 'notice pane: PC のターミナルに送れなかったので、自動で続けるのをやめました', 'stopped pane'], 15_000, false],
			twice: [false, true, false, ['notice pane: PC のターミナルに送れなかったので、自動で続けるのをやめました', 'stopped pane']],
		});
		for (const overload of [a, b, c]) {
			overload.dispose();
		}
	});
});
