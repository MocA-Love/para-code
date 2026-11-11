/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { configureParadisUsageSpanSender, ParadisSpanAttributes, recordParadisUsageSpan } from '../../common/paradisSentryDiagnostics.js';
import { isParadisUsageNameSendable, ParadisUsageSettingValue, ParadisUsageTally, paradisUsageBand } from '../../common/paradisUsageTally.js';
import { ParadisFakeUsageClock } from './paradisFakeUsageClock.js';

suite('Para Code usage tally (Sentry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function create(settings: () => Record<string, ParadisUsageSettingValue>) {
		const sent: { readonly name: string; readonly attributes: ParadisSpanAttributes }[] = [];
		const clock = new ParadisFakeUsageClock();
		const tally = new ParadisUsageTally({ feature: 'demo', operation: 'usage', intervalMs: 60_000, settings, send: (feature, operation, attributes) => sent.push({ name: `para.${feature}.${operation}`, attributes }), clock });
		return { sent, clock, tally };
	}

	test('数えた回数を間隔ごとに 1 件にまとめ、設定を on / off で載せる。空の窓は送らない', () => {
		const { sent, clock, tally } = create(() => ({ alpha: 'on', beta: 'off', minutes: 30 }));
		tally.flush();
		tally.add('calls');
		tally.add('calls');
		tally.add('wait_ms', 120.4);
		clock.advance(30_000);
		tally.add('calls');
		clock.advance(30_000);
		tally.dispose();
		assert.deepStrictEqual({ sent, pending: clock.pending }, {
			sent: [{ name: 'para.demo.usage', attributes: { safe_set_alpha: 'on', safe_set_beta: 'off', safe_set_minutes: 30, safe_calls: 3, safe_wait_ms: 120, safe_window_ms: 60_000 } }],
			pending: 0,
		});
	});

	test('窓の途中で設定が変わったら、それまでの分を先に送る（オンとオフを 1 件に混ぜない）', () => {
		let on = true;
		const { sent, tally } = create(() => ({ feature: on ? 'on' : 'off' }));
		tally.add('calls');
		on = false;
		tally.add('calls');
		tally.add('calls');
		tally.dispose();
		assert.deepStrictEqual(sent.map(entry => [entry.attributes.safe_set_feature, entry.attributes.safe_calls]), [['on', 1], ['off', 2]]);
	});

	test('送れない形の名前・Sentry が消す語を含む名前は送らず、落とした数だけを載せる', () => {
		const { sent, tally } = create(() => ({}));
		tally.add('Bad Name');
		tally.add('session_count');
		tally.add('ok_name');
		tally.add('ok_name', -1);
		tally.dispose();
		assert.deepStrictEqual(sent[0].attributes, { safe_ok_name: 1, safe_dropped_names: 2, safe_window_ms: 0 });
	});

	test('帯の名前', () => {
		assert.deepStrictEqual([0, 200, 201, 600, 601].map(value => paradisUsageBand(value, [200, 400, 600])), ['le_200', 'le_200', 'le_400', 'le_600', 'gt_600']);
		assert.deepStrictEqual(['calls', 'note_len_le_200', 'author_count', 'tokens', 'env_count', 'x'].map(isParadisUsageNameSendable), [true, true, false, false, false, true]);
	});

	test('main の送り口が繋がる前の記録は、繋がったときに送る', () => {
		const received: string[] = [];
		recordParadisUsageSpan('demo', 'early', { safe_value: 1 });
		configureParadisUsageSpanSender((feature, operation) => received.push(`${feature}.${operation}`));
		recordParadisUsageSpan('demo', 'late', { safe_value: 2 });
		configureParadisUsageSpanSender(undefined);
		assert.deepStrictEqual(received.filter(name => name.startsWith('demo.')), ['demo.early', 'demo.late']);
	});
});
