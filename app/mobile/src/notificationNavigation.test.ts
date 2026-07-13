import { describe, expect, it } from 'vitest';
import { notificationNavigationDecision } from './notificationNavigation.js';

describe('notificationNavigationDecision', () => {
	it('keeps a target pending until a complete desktop snapshot arrives', () => {
		expect(notificationNavigationDecision(undefined, 'terminal-a')).toBe('wait');
		expect(notificationNavigationDecision({ complete: false, terminals: [] }, 'terminal-a')).toBe('wait');
	});

	it('opens only an exact target in a complete snapshot', () => {
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-a' }] }, 'terminal-a')).toBe('open');
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-b' }] }, 'terminal-a')).toBe('missing');
		expect(notificationNavigationDecision({ complete: true, terminals: [{ terminalKey: 'terminal-b' }] }, undefined)).toBe('missing');
	});
});
