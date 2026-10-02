// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	DISCONNECT_WARNING,
	EDGE_RELEASE,
	HapticGate,
	KEY_TICK,
	MOVE_YIELD_MS,
	hapticPlan,
	hapticPrepareKind,
	hapticsAllowed,
	parseHapticsEnabled,
	serializeHapticsEnabled,
	type HapticToken,
} from './hapticTokens.js';

const TOKENS: readonly HapticToken[] = ['move', 'tick', 'commit', 'lift', 'edge', 'danger', 'success', 'warning', 'error', 'knock', 'charge', 'none'];

describe('hapticPlan', () => {
	it('maps every token to the designed native call, the expo-haptics fallback and the throttle', () => {
		expect(Object.fromEntries(TOKENS.map(token => [token, hapticPlan(token)]))).toEqual({
			move: { native: { kind: 'impact', style: 'light', intensity: 0.35 }, expo: { kind: 'selection' }, minIntervalMs: 250 },
			tick: { native: { kind: 'selection' }, expo: { kind: 'selection' }, minIntervalMs: 50 },
			commit: { native: { kind: 'impact', style: 'medium', intensity: 0.75 }, expo: { kind: 'impact', style: 'medium' }, minIntervalMs: 300 },
			lift: { native: { kind: 'impact', style: 'soft', intensity: 0.7 }, expo: { kind: 'impact', style: 'soft' }, minIntervalMs: 400 },
			edge: { native: { kind: 'impact', style: 'rigid', intensity: 0.55 }, expo: { kind: 'impact', style: 'rigid' }, minIntervalMs: 150 },
			danger: { native: { kind: 'impact', style: 'heavy', intensity: 0.85 }, expo: { kind: 'impact', style: 'heavy' }, minIntervalMs: 500 },
			success: { native: { kind: 'notify', type: 'success' }, expo: { kind: 'notify', type: 'success' }, minIntervalMs: 1_000 },
			warning: { native: { kind: 'notify', type: 'warning' }, expo: { kind: 'notify', type: 'warning' }, minIntervalMs: 1_000 },
			error: { native: { kind: 'notify', type: 'error' }, expo: { kind: 'notify', type: 'error' }, minIntervalMs: 1_000 },
			knock: { native: { kind: 'pattern', name: 'knock' }, expo: { kind: 'impact', style: 'medium' }, minIntervalMs: 3_000 },
			charge: { native: { kind: 'pattern', name: 'charge' }, expo: { kind: 'impact', style: 'rigid' }, minIntervalMs: 500 },
			none: undefined,
		});
	});

	it('plays a weak key tick as a light impact, an edge release as a sharp transient, and ignores overrides for results and patterns', () => {
		expect([
			hapticPlan('tick', KEY_TICK)?.native,
			hapticPlan('edge', EDGE_RELEASE)?.native,
			hapticPlan('commit', { intensity: 2 })?.native,
			hapticPlan('success', { intensity: 0.3 })?.native,
			hapticPlan('knock', { intensity: 0.3 })?.native,
		]).toEqual([
			{ kind: 'impact', style: 'light', intensity: 0.3 },
			{ kind: 'transient', intensity: 0.3, sharpness: 0.95 },
			{ kind: 'impact', style: 'medium', intensity: 1 },
			{ kind: 'notify', type: 'success' },
			{ kind: 'pattern', name: 'knock' },
		]);
	});

	it('falls back to a single light tap for the Core Haptics patterns in low power mode', () => {
		expect([hapticPlan('knock', { lowPower: true })?.native, hapticPlan('charge', { lowPower: true })?.native, hapticPlan('commit', { lowPower: true })?.native]).toEqual([
			{ kind: 'impact', style: 'medium', intensity: 0.6 },
			{ kind: 'selection' },
			{ kind: 'impact', style: 'medium', intensity: 0.75 },
		]);
	});
});

describe('hapticPrepareKind', () => {
	it('warms the generator that the token will use', () => {
		expect(Object.fromEntries(TOKENS.map(token => [token, hapticPrepareKind(token)]))).toEqual({
			move: 'impact-light',
			tick: 'selection',
			commit: 'impact-medium',
			lift: 'impact-soft',
			edge: 'impact-rigid',
			danger: 'impact-heavy',
			success: 'notification',
			warning: 'notification',
			error: 'notification',
			knock: 'engine',
			charge: 'engine',
			none: undefined,
		});
		expect([hapticPrepareKind('edge', EDGE_RELEASE), hapticPrepareKind('tick', KEY_TICK)]).toEqual(['engine', 'impact-light']);
	});
});

describe('HapticGate', () => {
	it('drops the same token inside its interval and lets other tokens and keys through', () => {
		const gate = new HapticGate();
		expect([
			gate.admit('commit', 0, 300),
			gate.admit('commit', 299, 300),
			gate.admit('commit', 300, 300),
			gate.admit('tick', 301, 50),
			gate.admit('warning', 400, 1_000),
			gate.admit('warning', 500, DISCONNECT_WARNING.minIntervalMs ?? 0, DISCONNECT_WARNING.key),
			gate.admit('warning', 20_000, DISCONNECT_WARNING.minIntervalMs ?? 0, DISCONNECT_WARNING.key),
			gate.admit('warning', 30_500, DISCONNECT_WARNING.minIntervalMs ?? 0, DISCONNECT_WARNING.key),
		]).toEqual([true, false, true, true, true, true, false, true]);
	});

	it('merges arrivals within 3 seconds into one knock', () => {
		const gate = new HapticGate();
		expect([0, 1_000, 2_999, 3_000, 4_000].map(at => gate.admit('knock', at, 3_000))).toEqual([true, false, false, true, false]);
	});

	it('does not stack a screen move right after another token', () => {
		const gate = new HapticGate();
		expect([
			gate.admit('commit', 1_000, 300),
			gate.admit('move', 1_000 + MOVE_YIELD_MS - 1, 250),
			gate.admit('move', 1_000 + MOVE_YIELD_MS, 250),
			gate.admit('move', 1_000 + MOVE_YIELD_MS + 100, 250),
			gate.admit('tick', 1_000 + MOVE_YIELD_MS + 101, 50),
		]).toEqual([true, false, true, false, true]);
	});
});

describe('hapticsAllowed', () => {
	it('plays only when enabled, in the foreground and on hardware that can play haptics', () => {
		expect([
			hapticsAllowed({ enabled: true, appState: 'active', supportsHaptics: true }),
			hapticsAllowed({ enabled: true, appState: 'active', supportsHaptics: undefined }),
			hapticsAllowed({ enabled: false, appState: 'active', supportsHaptics: true }),
			hapticsAllowed({ enabled: true, appState: 'inactive', supportsHaptics: true }),
			hapticsAllowed({ enabled: true, appState: 'background', supportsHaptics: true }),
			hapticsAllowed({ enabled: true, appState: 'active', supportsHaptics: false }),
		]).toEqual([true, true, false, false, false, false]);
	});
});

describe('haptics preference', () => {
	it('defaults to on and only stores off as 0', () => {
		expect([parseHapticsEnabled(null), parseHapticsEnabled(undefined), parseHapticsEnabled('1'), parseHapticsEnabled('0'), parseHapticsEnabled('garbage'), serializeHapticsEnabled(true), serializeHapticsEnabled(false)])
			.toEqual([true, true, true, false, true, '1', '0']);
	});
});
