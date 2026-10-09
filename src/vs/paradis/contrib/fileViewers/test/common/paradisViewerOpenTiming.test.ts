/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisSpanAttributes } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisViewerOpenCounter, startParadisViewerOpenTiming } from '../../common/paradisViewerOpenTiming.js';

suite('ParadisViewerOpenTiming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends the first and second paint of each viewer, once each, and nothing after', () => {
		const sent: ParadisSpanAttributes[] = [];
		const counter = new ParadisViewerOpenCounter();
		let clock = 0;
		const options = { recorder: (attributes: ParadisSpanAttributes) => sent.push(attributes), counter, now: () => clock };

		const first = startParadisViewerOpenTiming('pdf', options);
		clock = 840.4;
		first.painted({ safe_pages: 500 });
		first.painted({ safe_pages: 1 });

		// 描く前に閉じたものは送らず、回数にも数えない。
		const abandoned = startParadisViewerOpenTiming('pdf', options);
		abandoned.dispose();
		abandoned.painted();

		const markdown = startParadisViewerOpenTiming('markdown', options);
		clock = 900;
		markdown.painted({ safe_images: 2 });

		const second = startParadisViewerOpenTiming('pdf', options);
		clock = 1000;
		second.painted();
		const third = startParadisViewerOpenTiming('pdf', options);
		third.painted();

		deepStrictEqual(sent, [
			{ safe_pages: 500, safe_viewer: 'pdf', safe_open_ordinal: 1, safe_paint_ms: 840 },
			{ safe_images: 2, safe_viewer: 'markdown', safe_open_ordinal: 1, safe_paint_ms: 60 },
			{ safe_viewer: 'pdf', safe_open_ordinal: 2, safe_paint_ms: 100 },
		]);
	});

	test('never throws, even when sending fails', () => {
		const timing = startParadisViewerOpenTiming('image', { recorder: () => { throw new Error('offline'); }, counter: new ParadisViewerOpenCounter(), now: () => 0 });
		timing.painted();
		timing.dispose();
	});
});
