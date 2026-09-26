// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { sameLastSession, type LastSession } from './lastSession.js';

const current: LastSession = {
	pcId: 'pc-1',
	spaceId: '1:w1',
	terminalKey: 't1',
	title: 'claude',
	spaceName: 'space-a',
	branch: 'main',
	color: 'color-a',
	at: 1_000,
};

describe('sameLastSession', () => {
	it('treats the same contents as the same record regardless of the time', () => {
		const { at: _at, ...next } = current;
		expect(sameLastSession(current, next)).toBe(true);
	});

	it('is false when nothing is recorded yet', () => {
		const { at: _at, ...next } = current;
		expect(sameLastSession(undefined, next)).toBe(false);
	});

	it('is false when any shown field or the target differs', () => {
		const { at: _at, ...base } = current;
		expect(sameLastSession(current, { ...base, terminalKey: 't2' })).toBe(false);
		expect(sameLastSession(current, { ...base, title: 'codex' })).toBe(false);
		expect(sameLastSession(current, { ...base, branch: 'feat/x' })).toBe(false);
		const { terminalKey: _terminalKey, ...withoutTerminal } = base;
		expect(sameLastSession(current, withoutTerminal)).toBe(false);
	});
});
