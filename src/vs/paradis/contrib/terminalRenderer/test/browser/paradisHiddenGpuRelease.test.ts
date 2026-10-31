/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IParadisHiddenGpuReleaseHost, PARADIS_HIDDEN_GPU_RELEASE_DELAY, PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING, ParadisHiddenGpuRelease } from '../../browser/paradisHiddenGpuRelease.js';

class TestHost implements IParadisHiddenGpuReleaseHost<string> {
	readonly configuration = new TestConfigurationService({ [PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING]: true });
	gpu = true;
	readonly calls: string[] = [];
	set enabled(value: boolean) { this.configuration.setUserConfiguration(PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING, value); }
	hasGpuRenderer(): boolean { return this.gpu; }
	measureFont(): string { return this.gpu ? 'gpu-font' : 'dom-font'; }
	release(): void {
		this.calls.push('release');
		this.gpu = false;
	}
	reacquire(): void {
		this.calls.push('reacquire');
		this.gpu = true;
	}
}

suite('ParadisHiddenGpuRelease', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(host: TestHost): ParadisHiddenGpuRelease<string> {
		return store.add(new ParadisHiddenGpuRelease(() => host.configuration, host));
	}

	test('releases after the grace period and takes the renderer back when shown, keeping the GPU font size only while released', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const host = new TestHost();
		const release = create(host);
		release.setVisible(false);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY - 1);
		const beforeDelay = { calls: [...host.calls], font: release.releasedFont };
		await timeout(1);
		const afterDelay = { calls: [...host.calls], released: release.isReleased, font: release.releasedFont };
		release.setVisible(true);
		assert.deepStrictEqual(
			{ beforeDelay, afterDelay, afterShown: { calls: host.calls, released: release.isReleased, font: release.releasedFont } },
			{
				beforeDelay: { calls: [], font: undefined },
				afterDelay: { calls: ['release'], released: true, font: 'gpu-font' },
				afterShown: { calls: ['release', 'reacquire'], released: false, font: undefined },
			},
		);
	}));

	test('keeps the renderer when the terminal comes back within the grace period', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const host = new TestHost();
		const release = create(host);
		release.setVisible(false);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY / 2);
		release.setVisible(true);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY * 2);
		assert.deepStrictEqual({ calls: host.calls, released: release.isReleased }, { calls: [], released: false });
	}));

	test('does nothing while the setting is off, and does not touch a terminal without the GPU renderer', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const offHost = new TestHost();
		offHost.enabled = false;
		const off = create(offHost);
		off.setVisible(false);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY * 2);
		off.setVisible(true);

		const domHost = new TestHost();
		domHost.gpu = false;
		const dom = create(domHost);
		dom.setVisible(false);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY * 2);
		dom.setVisible(true);

		assert.deepStrictEqual({ off: offHost.calls, dom: domHost.calls }, { off: [], dom: [] });
	}));

	test('turning the setting off during the grace period cancels the release, and a released terminal is still given back', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const pendingHost = new TestHost();
		const pending = create(pendingHost);
		pending.setVisible(false);
		pendingHost.enabled = false;
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY * 2);

		const releasedHost = new TestHost();
		const released = create(releasedHost);
		released.setVisible(false);
		await timeout(PARADIS_HIDDEN_GPU_RELEASE_DELAY);
		releasedHost.enabled = false;
		released.setVisible(true);

		assert.deepStrictEqual({ pending: pendingHost.calls, released: releasedHost.calls }, { pending: [], released: ['release', 'reacquire'] });
	}));
});
