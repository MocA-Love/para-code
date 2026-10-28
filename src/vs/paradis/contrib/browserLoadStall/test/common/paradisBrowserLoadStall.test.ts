/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParaBrowserViewLoadStallOutcome } from '../../../../../platform/browserView/common/paraBrowserViewLoadStall.js';
import { paradisSanitizeSentryEvent } from '../../../sentry/common/paradisSentryCommon.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisBrowserRemoteKind, paradisBuildBrowserLoadStallEvent, paradisClassifyBrowserUrl } from '../../common/paradisBrowserLoadStall.js';

suite('paradisBrowserLoadStall', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies URLs without keeping the host', () => {
		const urls = [
			'http://localhost:3000/app',
			'http://app.localhost/',
			'http://127.0.0.2:8080/',
			'http://[::1]:5173/',
			'http://0.0.0.0:3000/',
			'http://192.168.1.10/',
			'http://10.0.0.5/',
			'http://172.20.0.1/',
			'http://172.32.0.1/',
			'http://100.100.1.1/',
			'http://devbox/',
			'http://printer.local/',
			'http://[fd12::1]/',
			'https://example.com/?q=secret',
			'file:///tmp/a.html',
			'about:blank',
			'not a url',
		];
		assert.deepStrictEqual(urls.map(url => {
			const { scheme, hostKind } = paradisClassifyBrowserUrl(url);
			return `${scheme}/${hostKind}`;
		}), [
			'http/loopback',
			'http/loopback',
			'http/loopback',
			'http/loopback',
			'http/loopback',
			'http/private-network',
			'http/private-network',
			'http/private-network',
			'http/public',
			'http/private-network',
			'http/private-network',
			'http/private-network',
			'http/private-network',
			'https/public',
			'other/none',
			'other/none',
			'other/none',
		]);
	});

	test('keeps only the kind of remote, never the host after the plus', () => {
		assert.deepStrictEqual(
			[undefined, '', 'ssh-remote+my-server', 'wsl+Ubuntu', 'dev-container+abc', 'my-own+thing'].map(paradisBrowserRemoteKind),
			['none', 'none', 'ssh-remote', 'wsl', 'dev-container', 'other'],
		);
	});

	test('builds a content-free event whose keys and fixed values survive Sentry scrubbing', () => {
		const event = paradisBuildBrowserLoadStallEvent({
			outcome: 'responded',
			url: 'http://localhost:3000/login?next=/secret',
			elapsedMs: 75_432.6,
			waits: 1,
			remoteAuthority: 'ssh-remote+my-server',
			tunnelProxy: true,
			agentTab: false,
			sample: { safe_main_rss_mb: 812.4, safe_system_free_mb: 2048, safe_page_memory_mb: Number.NaN, unexpected: 5 },
		});
		assert.deepStrictEqual(event, {
			operation: 'load-stall-responded',
			tags: {
				'para.browser_load_outcome': 'responded',
				'para.browser_url_host_kind': 'loopback',
				'para.browser_remote_kind': 'ssh-remote',
			},
			data: {
				safe_outcome: 'responded',
				safe_elapsed_ms: 75_433,
				safe_waits: 1,
				safe_url_scheme: 'http',
				safe_url_host_kind: 'loopback',
				safe_remote_kind: 'ssh-remote',
				safe_tunnel_proxy: true,
				safe_agent_tab: false,
				safe_main_rss_mb: 812,
				safe_system_free_mb: 2048,
			},
		});

		// The context survives the client-side sanitizer as sent.
		assert.deepStrictEqual(paradisSanitizeSentryEvent({ contexts: { 'para.browser_load': { ...event.data } } }).contexts, { 'para.browser_load': event.data });

		const outcomes: ParaBrowserViewLoadStallOutcome[] = ['stopped', 'agent-stopped', 'responded', 'failed', 'abandoned'];
		const words = new Set<string>(['browser-load', 'para.browser_load', 'safe_page_memory_mb', 'safe_app_memory_mb', 'safe_system_total_mb', 'private-network', 'public', 'loopback', 'none', 'other', 'https', 'tunnel', 'codespaces', 'attached-container', 'k8s-container']);
		for (const outcome of outcomes) {
			const built = paradisBuildBrowserLoadStallEvent({ outcome, url: 'https://example.com/', elapsedMs: 1, waits: 0, remoteAuthority: undefined, tunnelProxy: false, agentTab: false, sample: {} });
			words.add(built.operation);
			for (const [key, value] of [...Object.entries(built.tags), ...Object.entries(event.data)]) {
				words.add(key);
				if (typeof value === 'string') {
					words.add(value);
				}
			}
		}
		assert.deepStrictEqual([...words].filter(isParadisSentryScrubbedWord), []);
	});
});
