/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { MobileWarmLeaseLifecycle, shouldMaintainMobileWarmLease } from './store.js';

describe('mobile warm lease screen lifecycle', () => {
	it('requires focused, active and online for ccusage', () => {
		expect([
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: false, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: false, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('ccusage', { focused: true, appActive: true, online: false, volumeAxis: false }),
		]).toEqual([true, false, false, false]);
	});

	it('also requires the volume axis for space disk', () => {
		expect([
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: true, volumeAxis: false }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: false, appActive: true, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: false, online: true, volumeAxis: true }),
			shouldMaintainMobileWarmLease('spaceDisk', { focused: true, appActive: true, online: false, volumeAxis: true }),
		]).toEqual([true, false, false, false, false]);
	});

	it('releases synchronously as soon as any active condition becomes false', () => {
		const events: string[] = [];
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => { events.push('acquire'); return { dispose: () => events.push('release') }; };
		lifecycle.update(true, acquire);
		lifecycle.update(false, acquire);
		expect(events).toEqual(['acquire', 'release']);
		lifecycle.dispose();
		expect(events).toEqual(['acquire', 'release']);
	});
});
