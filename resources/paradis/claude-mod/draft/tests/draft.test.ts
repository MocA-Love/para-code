/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Run with `claude plugin test <a copy of this folder>` (Claude Code 2.1.300 or later), as the mod's own tests.

import type { On } from 'claude-code';
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing';

type Json = Record<string, unknown>;

const PORT_FILE = '/para-code-test/paradis-browser-mcp.json';

/** Para Code as the mod sees it; records the events posted to it. */
function fakeParaCode(on: On, posted: Json[], withPane = true, status: () => number = () => 200): MockClock {
	mock.env(on, withPane ? { PARA_CODE_TERMINAL_PANE_ID: 'pane-token', PARA_CODE_MCP_PORT_FILE: PORT_FILE } : {});
	const clock = mock.clock(on);
	on('fs.read', ($, e) => e.path === PORT_FILE ? { value: '{"port":47999}' } : { deny: 'no such file' });
	on('session.id', () => ({ value: 'session-1' }));
	on('session.start', ($, e) => ({ cwd: e.cwd }));
	on('prompt.edit', ($, e) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }));
	on('prompt.change', ($, e) => ({ text: e.text }));
	on('http.fetch', ($, e) => {
		const answer = status();
		posted.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') as Json, status: answer });
		return { value: { status: answer, ok: answer < 300, headers: {}, text: '{}' } };
	});
	return clock;
}

async function type($: Engine, before: string, inputText: string): Promise<void> {
	await $.prompt.edit({ origin: { kind: 'composer' }, text: before, cursor: before.length, start: before.length, end: before.length, inputText });
}

describe('para-code-draft mod', () => {
	test('sends the prompt box text at most every 150 ms, the last text of a burst included', async ($, on) => {
		const posted: Json[] = [];
		const clock = fakeParaCode(on, posted);
		await $.session.start({ cwd: '/para-code-test', surface: 'terminal', isInteractive: true });
		await type($, '', 'h');
		await type($, 'h', 'i');
		await clock.advance(150);
		await clock.settle();
		await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } });
		await clock.advance(150);
		await clock.settle();
		expect(posted.map(entry => ({ url: entry.url, events: ((entry.body as Json).events as Json[]).map(event => ({ type: event.type, text: event.text })) }))).toEqual([
			{ url: 'http://127.0.0.1:47999/claude-mod/v1/event', events: [{ type: 'draft', text: 'hi' }] },
			{ url: 'http://127.0.0.1:47999/claude-mod/v1/event', events: [{ type: 'draft', text: '' }] },
		]);
	});

	test('sends nothing outside a Para Code terminal or in a non-interactive session', async ($, on) => {
		const posted: Json[] = [];
		const clock = fakeParaCode(on, posted, false);
		await $.session.start({ cwd: '/para-code-test', surface: 'terminal', isInteractive: true });
		await type($, '', 'a');
		await clock.advance(150);
		await clock.settle();
		expect(posted).toEqual([]);
	});

	test('tries a refused send again with the latest text, and counts a text as sent only once Para Code took it', async ($, on) => {
		const posted: Json[] = [];
		const answers = [429, 200, 200];
		const clock = fakeParaCode(on, posted, true, () => answers.shift() ?? 200);
		await $.session.start({ cwd: '/para-code-test', surface: 'terminal', isInteractive: true });
		await type($, '', 'a');
		await clock.advance(150);
		await clock.settle();
		await type($, 'a', 'b');
		await clock.advance(150);
		await clock.settle();
		await clock.advance(1_000);
		await clock.settle();
		// the same text again is not sent once Para Code took it
		await $.prompt.change({ text: 'ab', cursor: 2, origin: { kind: 'engine' } });
		await clock.advance(150);
		await clock.settle();
		expect(posted.map(entry => [((entry.body as Json).events as Json[])[0]?.text, entry.status])).toEqual([['a', 429], ['ab', 200]]);
	});

	test('marks a text over 20,000 characters as cut', async ($, on) => {
		const posted: Json[] = [];
		const clock = fakeParaCode(on, posted);
		await $.session.start({ cwd: '/para-code-test', surface: 'terminal', isInteractive: true });
		await $.prompt.change({ text: 'x'.repeat(20_001), cursor: 0, origin: { kind: 'history' } });
		await clock.advance(150);
		await clock.settle();
		const event = ((posted[0]?.body as Json | undefined)?.events as Json[] | undefined)?.[0];
		expect({ length: String(event?.text).length, truncated: event?.truncated }).toEqual({ length: 20_000, truncated: true });
	});
});
