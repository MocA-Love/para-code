// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { KNOCK_MAX_AGE_MS, connectionHaptic, shouldKnockOnNotify } from './hapticEvents.js';

describe('shouldKnockOnNotify', () => {
	const now = 1_000_000;
	const base = { appState: 'active', now, questionsEnabled: true, bannerPresented: false, pushRegistered: true };

	it('knocks for a question in the foreground only when no banner will ring for it', () => {
		expect([
			shouldKnockOnNotify({ kind: 'agent-question', at: now }, base),
			shouldKnockOnNotify({ kind: 'agent-question', at: now }, { ...base, bannerPresented: true }),
			shouldKnockOnNotify({ kind: 'agent-question', quiet: 'pushed', at: now }, base),
			shouldKnockOnNotify({ kind: 'agent-question', quiet: 'pushed', at: now }, { ...base, pushRegistered: undefined }),
			shouldKnockOnNotify({ kind: 'agent-question', quiet: 'pushed', at: now }, { ...base, pushRegistered: false }),
			shouldKnockOnNotify({ kind: 'agent-question', quiet: 'muted', at: now }, base),
			shouldKnockOnNotify({ kind: 'agent-question', at: now }, { ...base, questionsEnabled: false }),
			shouldKnockOnNotify({ kind: 'agent-question', at: now }, { ...base, appState: 'inactive' }),
			shouldKnockOnNotify({ kind: 'agent-question', at: now }, { ...base, appState: 'background' }),
			shouldKnockOnNotify({ kind: 'agent-done', at: now }, base),
			shouldKnockOnNotify({ kind: 'agent-error', at: now }, base),
			shouldKnockOnNotify({ kind: 'disconnected', at: now }, base),
		]).toEqual([true, false, false, false, true, false, false, false, false, false, false, false]);
	});

	it('does not knock for held-back notifications that the PC replays after a reconnect', () => {
		expect([
			shouldKnockOnNotify({ kind: 'agent-question', at: now - KNOCK_MAX_AGE_MS }, base),
			shouldKnockOnNotify({ kind: 'agent-question', at: now - KNOCK_MAX_AGE_MS - 1 }, base),
			shouldKnockOnNotify({ kind: 'agent-question', at: now - 10 * 60_000 }, base),
		]).toEqual([true, false, false]);
	});
});

describe('connectionHaptic', () => {
	const steady = { wasOnline: false, online: false, wasRejected: false, rejected: false, manualOffline: false, userRequested: false };

	it('answers a pressed connect with success or error, warns on an unintended drop and stays quiet otherwise', () => {
		expect([
			connectionHaptic({ ...steady, online: true, userRequested: true }),
			connectionHaptic({ ...steady, online: true }),
			connectionHaptic({ ...steady, rejected: true, userRequested: true }),
			connectionHaptic({ ...steady, rejected: true }),
			connectionHaptic({ ...steady, wasOnline: true }),
			connectionHaptic({ ...steady, wasOnline: true, manualOffline: true }),
			connectionHaptic({ ...steady, wasOnline: true, online: true, userRequested: true }),
			connectionHaptic(steady),
		]).toEqual(['success', undefined, 'error', undefined, 'warning', undefined, undefined, undefined]);
	});
});
