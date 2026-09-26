// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { createTerminalAttachments } from './terminalAttachments.js';

function setup() {
	const calls: string[] = [];
	const attachments = createTerminalAttachments(key => calls.push(`attach:${key}`), key => calls.push(`detach:${key}`));
	return { calls, attachments };
}

describe('createTerminalAttachments', () => {
	it('attaches on hold and detaches when the only holder releases', () => {
		const { calls, attachments } = setup();
		const release = attachments.hold('t1');
		release();
		expect(calls).toEqual(['attach:t1', 'detach:t1']);
		expect(attachments.count('t1')).toBe(0);
	});

	it('keeps the subscription while another screen still holds the same terminal', () => {
		const { calls, attachments } = setup();
		const releaseBottom = attachments.hold('t1');
		const releaseTop = attachments.hold('t1');
		releaseTop();
		expect(calls).toEqual(['attach:t1', 'attach:t1']);
		expect(attachments.count('t1')).toBe(1);
		releaseBottom();
		expect(calls).toEqual(['attach:t1', 'attach:t1', 'detach:t1']);
	});

	it('does not care about the order of release', () => {
		const { calls, attachments } = setup();
		const releaseBottom = attachments.hold('t1');
		const releaseTop = attachments.hold('t1');
		releaseBottom();
		expect(calls).not.toContain('detach:t1');
		releaseTop();
		expect(calls.at(-1)).toBe('detach:t1');
	});

	it('counts each release only once', () => {
		const { calls, attachments } = setup();
		const releaseA = attachments.hold('t1');
		attachments.hold('t1');
		releaseA();
		releaseA();
		expect(calls).not.toContain('detach:t1');
		expect(attachments.count('t1')).toBe(1);
	});

	it('counts terminals separately', () => {
		const { calls, attachments } = setup();
		attachments.hold('t1');
		const releaseB = attachments.hold('t2');
		releaseB();
		expect(calls).toEqual(['attach:t1', 'attach:t2', 'detach:t2']);
		expect(attachments.count('t1')).toBe(1);
	});
});
