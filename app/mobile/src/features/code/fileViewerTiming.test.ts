// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { MobileTimingAttributes } from '../../mobileDiagnostics.js';
import { FileViewerLoadTrace, measureBuild } from './fileViewerTiming.js';

function setup(fetchKind: string, path: string) {
	let now = 0;
	const recorded: { readonly startedAt: number; readonly endedAt: number; readonly attributes: MobileTimingAttributes }[] = [];
	const trace = new FileViewerLoadTrace(fetchKind, path, (_feature, _operation, startedAt, endedAt, attributes) => {
		recorded.push({ startedAt, endedAt, attributes });
	}, () => now);
	return { trace, recorded, at: (ms: number) => { now = ms; } };
}

describe('FileViewerLoadTrace', () => {
	test('sends one sample once the WebView finishes loading', () => {
		const { trace, recorded, at } = setup('text', 'docs/page.html');
		at(60_000);
		trace.fetched({ id: 'p-r-4', t: 'read' });
		trace.viewing('html', 'render');
		trace.htmlBuilt(3, 3_100_000);
		trace.htmlBuilt(50, 10);
		at(60_500);
		trace.loadStarted();
		at(62_000);
		trace.loadEnded();
		trace.cancel();

		expect(recorded).toEqual([{
			startedAt: 0,
			endedAt: 62_000,
			attributes: {
				safe_kind: 'text',
				safe_ext: 'html',
				safe_request_id: 'p-r-4',
				safe_viewer: 'html',
				safe_mode: 'render',
				safe_html_build_ms: 3,
				safe_html_chars: 3_100_000,
				safe_outcome: 'ok',
				safe_total_ms: 62_000,
				safe_fetch_ms: 60_000,
				safe_to_load_start_ms: 500,
				safe_webview_load_ms: 1_500,
			},
		}]);
	});

	test('reports a viewer closed while still waiting, and ignores loads before the content arrived', () => {
		const { trace, recorded, at } = setup('pdf', 'a/b.pdf');
		trace.loadStarted();
		trace.loadEnded();
		at(45_000);
		trace.cancel();
		trace.failed();

		expect(recorded.map(entry => entry.attributes)).toEqual([
			{ safe_kind: 'pdf', safe_ext: 'pdf', safe_outcome: 'cancelled', safe_total_ms: 45_000 },
		]);
	});

	test('measures how long a build took', () => {
		const times = [10, 25];
		expect(measureBuild(() => 'html', () => times.shift()!)).toEqual({ value: 'html', ms: 15 });
	});
});
