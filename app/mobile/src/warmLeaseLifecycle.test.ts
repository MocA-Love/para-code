/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { mobileWarmLeaseOwnerRevision, MobileWarmLeaseLifecycle, shouldMaintainMobileWarmLease } from './store.js';

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

	it('hands an active lease off when the active PC identity or controller revision changes', () => {
		const events: string[] = [];
		let owner = 'old';
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => {
			const captured = owner;
			events.push(`${captured}:acquire`);
			return { dispose: () => events.push(`${captured}:release`) };
		};
		lifecycle.update(true, acquire, 'pc-a:revision-1');
		owner = 'new';
		lifecycle.update(true, acquire, 'pc-b:revision-2');
		expect(events).toEqual(['old:acquire', 'old:release', 'new:acquire']);
		lifecycle.dispose();
		expect(events).toEqual(['old:acquire', 'old:release', 'new:acquire', 'new:release']);
	});

	it('treats both active PC identity and controller revision as owner changes', () => {
		const events: string[] = [];
		const lifecycle = new MobileWarmLeaseLifecycle();
		const acquire = () => {
			events.push('acquire');
			return { dispose: () => events.push('release') };
		};
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-a', 1));
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-b', 1));
		lifecycle.update(true, acquire, mobileWarmLeaseOwnerRevision('pc-b', 2));
		expect(events).toEqual(['acquire', 'release', 'acquire', 'release', 'acquire']);
		lifecycle.dispose();
	});
});
