/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord, ParadisSpanAttributes } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisFakeUsageClock } from '../../../sentry/test/common/paradisFakeUsageClock.js';
import { ParadisBrowserExtensionsUsage } from '../../common/paradisBrowserExtensionsUsage.js';

suite('Para Browser extensions usage (Sentry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('読み込み・worker・ポップアップ・サイドパネルを決まった名前の回数にし、ID や名前は載せない', () => {
		const sent: ParadisSpanAttributes[] = [];
		const usage = new ParadisBrowserExtensionsUsage((_feature, _operation, attributes) => sent.push(attributes), new ParadisFakeUsageClock());
		usage.setEnabled(true);
		usage.noteLoadAll(0);
		usage.noteLoadAll(2);
		usage.noteLoadAll(12);
		for (const outcome of ['ok', 'ok', 'prepare_failed', 'id_mismatch', 'error'] as const) {
			usage.noteLoad(outcome);
		}
		usage.noteWorkerStartFailed(true);
		usage.noteWorkerStartFailed(false);
		for (const outcome of ['opened', 'no_window_other', 'no_window_missing', 'load_failed'] as const) {
			usage.notePopup(outcome, true);
		}
		usage.noteSidePanel('opened', true);
		usage.noteSidePanel('refused_shared', true);
		usage.flush();
		assert.deepStrictEqual({
			attributes: sent,
			scrubbed: Object.keys(sent[0]).filter(isParadisSentryScrubbedWord),
		}, {
			attributes: [{
				safe_set_enabled: 'on', safe_set_allow_while_shared: 'off',
				safe_load_runs: 3, safe_ext_count_le_0: 1, safe_ext_count_le_3: 1, safe_ext_count_gt_10: 1,
				safe_load_ok: 2, safe_load_prepare_failed: 1, safe_load_id_mismatch: 1, safe_load_error: 1,
				safe_worker_start_failed: 2, safe_worker_start_failed_script: 1,
				safe_popup_opened: 1, safe_popup_on_shared: 1, safe_popup_no_window_other: 1, safe_popup_no_window_missing: 1, safe_popup_load_failed: 1,
				safe_side_panel_opened: 1, safe_side_panel_on_shared: 1, safe_side_panel_refused_shared: 1,
				safe_window_ms: 0,
			}],
			scrubbed: [],
		});
	});
});
