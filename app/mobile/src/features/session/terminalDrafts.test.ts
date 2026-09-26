// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { terminalDraftKey, withTerminalDraft } from './terminalDrafts.js';

describe('terminal drafts', () => {
	it('keeps a draft per terminal and per PC', () => {
		expect(terminalDraftKey('pc-1', 't1')).not.toBe(terminalDraftKey('pc-2', 't1'));
		expect(terminalDraftKey('pc-1', 't1')).not.toBe(terminalDraftKey('pc-1', 't2'));
	});

	it('stores text and drops the key when it becomes empty', () => {
		const withText = withTerminalDraft({}, 'a', 'ls -la');
		expect(withText).toEqual({ a: 'ls -la' });
		expect(withTerminalDraft(withText, 'a', '')).toEqual({});
	});

	it('returns the same object when nothing changes', () => {
		const drafts = { a: 'git status' };
		expect(withTerminalDraft(drafts, 'a', 'git status')).toBe(drafts);
		expect(withTerminalDraft(drafts, 'b', '')).toBe(drafts);
	});
});
