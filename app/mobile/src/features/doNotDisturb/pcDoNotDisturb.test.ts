// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	DO_NOT_DISTURB_DURATION_OPTIONS,
	doNotDisturbResultText,
	doNotDisturbSetReplyState,
	doNotDisturbSetRequest,
	newDoNotDisturbOpId,
	pcDoNotDisturbRow,
} from './pcDoNotDisturb.js';

const NOW = new Date(2026, 9, 6, 23, 18, 0, 0).getTime();

describe('PC のおやすみモード（スマホから切り替える）', () => {
	it('対応・接続・状態・送信中で行の出し分けが変わる', () => {
		const on = { enabled: true, until: NOW + 42 * 60_000 };
		const rows = {
			unsupported: pcDoNotDisturbRow({ supported: false, connected: true, state: on, pending: false }, NOW),
			onTimed: pcDoNotDisturbRow({ supported: true, connected: true, state: on, pending: false }, NOW),
			onManual: pcDoNotDisturbRow({ supported: true, connected: true, state: { enabled: true }, pending: false }, NOW),
			off: pcDoNotDisturbRow({ supported: true, connected: true, state: { enabled: false }, pending: false }, NOW),
			expired: pcDoNotDisturbRow({ supported: true, connected: true, state: { enabled: true, until: NOW - 1 }, pending: false }, NOW),
			notReported: pcDoNotDisturbRow({ supported: true, connected: true, state: undefined, pending: false }, NOW),
			pending: pcDoNotDisturbRow({ supported: true, connected: true, state: { enabled: false }, pending: true }, NOW),
			offlineOn: pcDoNotDisturbRow({ supported: true, connected: false, state: on, pending: false }, NOW),
			offlineUnknown: pcDoNotDisturbRow({ supported: true, connected: false, state: undefined, pending: false }, NOW),
			// 起動してから一度も State を受けていない PC は、対応か分からないので「更新」の案内を出さない
			neverSeenOffline: pcDoNotDisturbRow({ supported: undefined, connected: false, state: undefined, pending: false }, NOW),
			neverSeenConnecting: pcDoNotDisturbRow({ supported: undefined, connected: true, state: undefined, pending: false }, NOW),
		};
		expect(rows).toEqual({
			unsupported: { hint: 'この PC は更新すると、ここから切り替えられます', value: undefined, showSwitch: false, on: false, disabled: true },
			onTimed: { hint: 'あと 42分で解除', value: undefined, showSwitch: true, on: true, disabled: false },
			onManual: { hint: '自分でオフにするまで', value: undefined, showSwitch: true, on: true, disabled: false },
			off: { hint: undefined, value: undefined, showSwitch: true, on: false, disabled: false },
			expired: { hint: undefined, value: undefined, showSwitch: true, on: false, disabled: false },
			notReported: { hint: 'PC の状態を確かめています', value: undefined, showSwitch: true, on: false, disabled: true },
			pending: { hint: '設定中…', value: undefined, showSwitch: true, on: false, disabled: true },
			offlineOn: { hint: 'オフラインのため変えられません', value: 'オン', showSwitch: false, on: true, disabled: true },
			offlineUnknown: { hint: 'オフラインのため変えられません', value: '不明', showSwitch: false, on: false, disabled: true },
			neverSeenOffline: { hint: 'オフラインのため変えられません', value: '不明', showSwitch: false, on: false, disabled: true },
			neverSeenConnecting: { hint: 'PC の状態を確かめています', value: undefined, showSwitch: true, on: false, disabled: true },
		});
	});

	it('選択肢は PC と同じ 4 つ。送るのは id だけで、応答の状態とお知らせの文を読む', () => {
		const opId = newDoNotDisturbOpId(NOW);
		expect({
			options: DO_NOT_DISTURB_DURATION_OPTIONS,
			on: doNotDisturbSetRequest('op-1', 'morning'),
			off: doNotDisturbSetRequest('op-2', undefined),
			uniqueOpIds: opId !== newDoNotDisturbOpId(NOW) && opId.length <= 100,
			reply: doNotDisturbSetReplyState({ t: 'dndSet', state: { enabled: true, until: new Date(2026, 9, 7, 7, 0, 0, 0).getTime() } }),
			brokenReply: doNotDisturbSetReplyState({ t: 'dndSet', state: { enabled: 1 } }),
			resultOn: doNotDisturbResultText('MacBook Pro', { enabled: true, until: new Date(2026, 9, 7, 0, 18, 0, 0).getTime() }, NOW),
			resultManual: doNotDisturbResultText('MacBook Pro', { enabled: true }, NOW),
			resultOff: doNotDisturbResultText('MacBook Pro', { enabled: false }, NOW),
		}).toEqual({
			options: [
				{ value: 'minutes30', label: '30分' },
				{ value: 'hours1', label: '1時間' },
				{ value: 'morning', label: '朝まで（7:00）' },
				{ value: 'manual', label: '自分でオフにするまで' },
			],
			on: { t: 'dndSet', opId: 'op-1', enabled: true, duration: 'morning' },
			off: { t: 'dndSet', opId: 'op-2', enabled: false },
			uniqueOpIds: true,
			reply: { enabled: true, until: new Date(2026, 9, 7, 7, 0, 0, 0).getTime() },
			brokenReply: undefined,
			resultOn: { text: 'MacBook Pro をおやすみモードにしました', sub: '0:18 に解除' },
			resultManual: { text: 'MacBook Pro をおやすみモードにしました', sub: '自分でオフにするまで' },
			resultOff: { text: 'MacBook Pro のおやすみモードを解除しました' },
		});
	});
});
