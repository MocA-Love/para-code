/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisSpanAttributes } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisMobileFileTiming, paradisMobileFileTimingExtension } from '../../common/paradisMobileFileTiming.js';

suite('ParadisMobileFileTiming', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function clock(times: number[]): () => number {
		return () => {
			const next = times.shift();
			assert.notStrictEqual(next, undefined, 'clock read more often than expected');
			return next!;
		};
	}

	test('records each phase once, sizes and the outcome as a single sample', () => {
		const recorded: ParadisSpanAttributes[] = [];
		const timing = ParadisMobileFileTiming.start(
			{ t: 'read', id: 'abc-r-3', path: 'docs/Report.HTML', highlight: true },
			1_000,
			attributes => recorded.push(attributes),
			// resolve_path, stat, read, highlight_wait, highlight_wait (2回目は加算), send, total
			clock([1_005, 1_010, 1_100, 1_400, 1_450, 1_460, 1_460]),
		)!;
		timing.mark('resolve_path');
		timing.mark('stat');
		timing.mark('read');
		timing.mark('highlight_wait');
		timing.mark('highlight_wait');
		timing.set({ safe_source_bytes: 3_100_000 });
		timing.setOutcome('not-modified');
		timing.sent(1_900_000);
		timing.sent(1);

		assert.deepStrictEqual(recorded, [{
			safe_request_id: 'abc-r-3',
			safe_kind: 'read',
			safe_outcome: 'not-modified',
			safe_total_ms: 460,
			safe_reply_bytes: 1_900_000,
			safe_ext: 'html',
			safe_highlight: true,
			safe_source_bytes: 3_100_000,
			safe_resolve_path_ms: 5,
			safe_stat_ms: 5,
			safe_read_ms: 90,
			safe_highlight_wait_ms: 350,
			safe_send_ms: 10,
		}]);
	});

	test('ignores requests the file viewer does not make', () => {
		assert.deepStrictEqual([
			ParadisMobileFileTiming.start({ t: 'list', id: 'a', path: 'x' }, 0, () => { }),
			ParadisMobileFileTiming.start({ t: 'read', path: 'x' }, 0, () => { }),
		], [undefined, undefined]);
	});

	test('sends only the extension of a path, never the name', () => {
		assert.deepStrictEqual(
			['a/b/page.html', 'C:\\x\\Doc.PDF', 'Makefile', '.env', 'a.verylongextension', 'a.tar.gz', 'a.b c'].map(paradisMobileFileTimingExtension),
			['html', 'pdf', 'none', 'none', 'other', 'gz', 'other'],
		);
	});
});
