/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	createParadisChildProcessGoneDiagnostic,
	createParadisRenderProcessGoneDiagnostic,
	registerParadisProcessGoneDiagnosticListeners,
	type IParadisChildProcessGoneDetails,
	type IParadisRenderProcessGoneDetails,
	type IParadisProcessGoneEventSource,
} from '../../common/paradisProcessGone.js';

class FakeProcessGoneEventSource implements IParadisProcessGoneEventSource {
	private childProcessGoneListener: ((event: object, details: IParadisChildProcessGoneDetails) => void) | undefined;
	private renderProcessGoneListener: ((event: object, webContents: object, details: IParadisRenderProcessGoneDetails) => void) | undefined;

	on(event: 'child-process-gone', listener: (event: object, details: IParadisChildProcessGoneDetails) => void): void;
	on(event: 'render-process-gone', listener: (event: object, webContents: object, details: IParadisRenderProcessGoneDetails) => void): void;
	on(event: 'child-process-gone' | 'render-process-gone', listener: ((event: object, details: IParadisChildProcessGoneDetails) => void) | ((event: object, webContents: object, details: IParadisRenderProcessGoneDetails) => void)): void {
		if (event === 'child-process-gone') {
			this.childProcessGoneListener = listener as (event: object, details: IParadisChildProcessGoneDetails) => void;
		} else {
			this.renderProcessGoneListener = listener as (event: object, webContents: object, details: IParadisRenderProcessGoneDetails) => void;
		}
	}

	emitChildProcessGone(details: IParadisChildProcessGoneDetails): void {
		this.childProcessGoneListener?.({}, details);
	}

	emitRenderProcessGone(webContents: object, details: IParadisRenderProcessGoneDetails): void {
		this.renderProcessGoneListener?.({}, webContents, details);
	}
}

suite('ParadisProcessGone', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('child process diagnostic prefers its explicit name over service and type', () => {
		const diagnostic = createParadisChildProcessGoneDiagnostic({
			type: 'Utility',
			name: 'fileWatcher',
			serviceName: 'node.mojom.NodeService',
			reason: 'crashed',
			exitCode: 9,
		}, 4_200);

		assert.deepStrictEqual(diagnostic && {
			operation: diagnostic.operation,
			errorMessage: diagnostic.error.message,
			safeExtra: diagnostic.safeExtra,
		}, {
			operation: 'child-process-gone-crashed-file-watcher',
			errorMessage: 'Child process gone: Utility/fileWatcher (crashed)',
			safeExtra: {
				process_type: 'Utility',
				failure_code: 'crashed',
				exit_code: 9,
				duration_ms: 4_200,
				safe_service_name: 'node.mojom.NodeService',
				safe_process_name: 'fileWatcher',
			},
		});
	});

	test('child process diagnostic uses its service name when its explicit name is absent', () => {
		const diagnostic = createParadisChildProcessGoneDiagnostic({
			type: 'Utility',
			serviceName: 'node.mojom.NodeService',
			reason: 'killed',
			exitCode: 15,
		}, 250);

		assert.strictEqual(diagnostic?.error.message, 'Child process gone: Utility/node.mojom.NodeService (killed)');
	});

	test('child process diagnostic uses its type when it has no name or service name', () => {
		const diagnostic = createParadisChildProcessGoneDiagnostic({
			type: 'GPU',
			reason: 'abnormal-exit',
			exitCode: 1,
		}, 250);

		assert.strictEqual(diagnostic?.error.message, 'Child process gone: GPU/GPU (abnormal-exit)');
	});

	test('child process diagnostic operation distinguishes process kinds and ignores instance indices', () => {
		const gpuKilled = createParadisChildProcessGoneDiagnostic({ type: 'GPU', reason: 'killed', exitCode: 9 }, 250);
		const networkKilled = createParadisChildProcessGoneDiagnostic({ type: 'Utility', name: 'Network Service', reason: 'killed', exitCode: 9 }, 250);
		const watcherFirst = createParadisChildProcessGoneDiagnostic({ type: 'Utility', name: 'fileWatcher-1', reason: 'crashed', exitCode: 9 }, 250);
		const watcherThird = createParadisChildProcessGoneDiagnostic({ type: 'Utility', name: 'fileWatcher-3', reason: 'crashed', exitCode: 9 }, 250);

		// Same reason, different process kinds: distinct operations, so they no longer share a Sentry issue.
		assert.notStrictEqual(gpuKilled?.operation, networkKilled?.operation);
		// Same process kind, different instance index: same operation, so repeats still group together.
		assert.strictEqual(watcherFirst?.operation, watcherThird?.operation);
		assert.strictEqual(watcherFirst?.operation, 'child-process-gone-crashed-file-watcher');
	});

	test('does not create diagnostics for clean child or renderer exits', () => {
		assert.strictEqual(createParadisChildProcessGoneDiagnostic({
			type: 'Utility',
			reason: 'clean-exit',
			exitCode: 0,
		}, 100), undefined);
		assert.strictEqual(createParadisRenderProcessGoneDiagnostic({
			reason: 'clean-exit',
			exitCode: 0,
		}, 100), undefined);
	});

	test('renderer diagnostic excludes URL, title, and WebContents information', () => {
		const details = {
			reason: 'crashed',
			exitCode: 133,
			url: 'file:///Users/alice/private-project/readme.md',
			title: 'Private Project',
			webContentsId: 42,
		};
		const diagnostic = createParadisRenderProcessGoneDiagnostic(details, 3_000);

		assert.deepStrictEqual(diagnostic && {
			operation: diagnostic.operation,
			errorMessage: diagnostic.error.message,
			safeExtra: diagnostic.safeExtra,
		}, {
			operation: 'render-process-gone-crashed',
			errorMessage: 'Renderer process gone (crashed)',
			safeExtra: {
				process_type: 'renderer',
				failure_code: 'crashed',
				exit_code: 133,
				duration_ms: 3_000,
			},
		});
	});

	test('registers both process-gone listeners and reports only unexpected exits with safe payloads', () => {
		const eventSource = new FakeProcessGoneEventSource();
		const reports: Array<[string, string, string, string, Record<string, unknown> | undefined]> = [];
		registerParadisProcessGoneDiagnosticListeners(eventSource, (scope, feature, operation, error, safeExtra) => {
			reports.push([scope, feature, operation, error.message, safeExtra]);
		}, () => 8_000);

		eventSource.emitChildProcessGone({ type: 'Utility', name: 'extensionHost', serviceName: 'node.mojom.NodeService', reason: 'crashed', exitCode: 9 });
		eventSource.emitChildProcessGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 });
		eventSource.emitRenderProcessGone({ url: 'file:///Users/alice/private-project/readme.md', title: 'Private Project', id: 42 }, { reason: 'oom', exitCode: 134 });
		eventSource.emitRenderProcessGone({ url: 'file:///Users/alice/private-project/notes.md', title: 'Private Notes', id: 43 }, { reason: 'clean-exit', exitCode: 0 });

		assert.deepStrictEqual(reports, [
			[
				'owned',
				'process-lifecycle',
				'child-process-gone-crashed-extension-host',
				'Child process gone: Utility/extensionHost (crashed)',
				{
					process_type: 'Utility',
					failure_code: 'crashed',
					exit_code: 9,
					duration_ms: 8_000,
					safe_service_name: 'node.mojom.NodeService',
					safe_process_name: 'extensionHost',
				},
			],
			[
				'owned',
				'process-lifecycle',
				'render-process-gone-oom',
				'Renderer process gone (oom)',
				{
					process_type: 'renderer',
					failure_code: 'oom',
					exit_code: 134,
					duration_ms: 8_000,
				},
			],
		]);
	});
});
