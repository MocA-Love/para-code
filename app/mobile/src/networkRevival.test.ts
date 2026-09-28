// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';

// ネイティブ部品が無いビルドを再現する（requireOptionalNativeModule が null を返す）。
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

import { shouldNudgeForNetworkChange, subscribeNetworkRevival, type NetworkModuleLike, type NetworkSnapshot } from './networkRevival.js';

class FakeNetwork implements NetworkModuleLike {
	listener: ((state: NetworkSnapshot) => void) | undefined;
	removed = false;
	constructor(private readonly initial: NetworkSnapshot) { }
	getNetworkStateAsync(): Promise<NetworkSnapshot> {
		return Promise.resolve(this.initial);
	}
	addListener(_eventName: 'onNetworkStateChanged', listener: (state: NetworkSnapshot) => void) {
		this.listener = listener;
		return { remove: () => { this.removed = true; } };
	}
}

const wifi = { isConnected: true, type: 'WIFI' };
const cellular = { isConnected: true, type: 'CELLULAR' };
const offline = { isConnected: false, type: 'NONE' };

describe('shouldNudgeForNetworkChange', () => {
	it('nudges when the network comes back or switches, not when it drops or on the first report', () => {
		expect([
			shouldNudgeForNetworkChange(offline, wifi),
			shouldNudgeForNetworkChange(wifi, cellular),
			shouldNudgeForNetworkChange(cellular, wifi),
			shouldNudgeForNetworkChange(wifi, offline),
			shouldNudgeForNetworkChange(wifi, wifi),
			shouldNudgeForNetworkChange(undefined, wifi),
			shouldNudgeForNetworkChange({ isConnected: true }, { isConnected: true, type: 'WIFI' }),
		]).toEqual([true, true, true, false, false, false, false]);
	});
});

describe('subscribeNetworkRevival', () => {
	it('nudges on each revival after reading the starting state, and stops after unsubscribing', async () => {
		const network = new FakeNetwork(wifi);
		const nudges: number[] = [];
		const unsubscribe = subscribeNetworkRevival(() => nudges.push(1), network);
		await Promise.resolve();
		network.listener!(offline);
		network.listener!(wifi);
		network.listener!(cellular);
		expect(nudges.length).toBe(2);
		unsubscribe();
		network.listener!(offline);
		network.listener!(wifi);
		expect({ nudges: nudges.length, removed: network.removed }).toEqual({ nudges: 2, removed: true });
	});

	it('does nothing on a build without the native module', () => {
		const onNudge = vi.fn();
		const unsubscribe = subscribeNetworkRevival(onNudge);
		expect(() => unsubscribe()).not.toThrow();
		expect(onNudge).not.toHaveBeenCalled();
	});
});
