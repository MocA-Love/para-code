/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { ParadisSiteNotesStore, paradisFormatSiteNotesHint, paradisSiteNoteLooksSecret, paradisSiteNoteOrigin } from '../../node/paradisBrowserSiteNotes.js';

const TOKEN = 'pane-token';

function textOf(result: unknown): string {
	return ((result as { content: { text?: string }[] }).content).map(item => item.text ?? '').join('\n');
}

interface ISiteNotesInternals {
	_dispatch(ingressLease: object, rpc: { jsonrpc: string; id: number; method: string; params?: unknown }): Promise<unknown>;
	_siteNoteTool(ingressLease: object, name: string, args: unknown): Promise<unknown>;
	_withSiteNotesHint(ingressLease: object, name: string, args: unknown, result: unknown): Promise<unknown>;
}

suite('Paradis site notes (E4)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let folder: string;
	setup(async () => {
		folder = await fs.mkdtemp(join(tmpdir(), 'paradis-site-notes-'));
	});
	teardown(async () => {
		await fs.rm(folder, { recursive: true, force: true });
	});

	test('notes are kept per repository and origin, with their date and writer, and survive a new store', async () => {
		const file = join(folder, 'notes.json');
		const store = new ParadisSiteNotesStore(file, () => new Date('2026-10-10T03:00:00Z'));
		const first = await store.write('/repo-a', 'http://localhost:3000', '  Dates are filled as YYYY/MM/DD.  ', { agent: 'claude', commit: 'abc1234' });
		await store.write('/repo-b', 'http://localhost:3000', 'Another product on the same port.', { agent: 'codex' });
		const reread = new ParadisSiteNotesStore(file);
		const deleted = await reread.delete('/repo-a', 'http://localhost:3000', first.id);
		const missing = await reread.delete('/repo-a', 'http://localhost:3000', first.id);
		assert.deepStrictEqual({
			first: { text: first.text, date: first.date, agent: first.agent, commit: first.commit },
			repoB: (await reread.list('/repo-b', 'http://localhost:3000')).map(note => note.text),
			deleted,
			missing,
			repoA: await reread.list('/repo-a', 'http://localhost:3000'),
		}, {
			first: { text: 'Dates are filled as YYYY/MM/DD.', date: '2026-10-10', agent: 'claude', commit: 'abc1234' },
			repoB: ['Another product on the same port.'],
			deleted: true,
			missing: false,
			repoA: [],
		});
	});

	test('origins, the hint wording and the secret check', () => {
		assert.deepStrictEqual({
			origins: [paradisSiteNoteOrigin('https://example.com/a/b?c'), paradisSiteNoteOrigin('http://localhost:3000/x'), paradisSiteNoteOrigin('file:///tmp/a.html'), paradisSiteNoteOrigin('nope')],
			hint: paradisFormatSiteNotesHint('https://example.com', [{ id: 'n1', text: 'Save is in the iframe.', date: '2026-10-10', agent: 'codex', commit: 'abc1234' }]),
			none: paradisFormatSiteNotesHint('https://example.com', []),
			secrets: ['password: hunter2', 'Use token=ghp_abcdefghijklmnopqrstuvwxyz', 'Click Save twice'].map(paradisSiteNoteLooksSecret),
		}, {
			origins: ['https://example.com', 'http://localhost:3000', undefined, undefined],
			hint: '[Site notes for https://example.com] Hints left by earlier agents in this repository. They may be out of date: check them against the page, and fix or delete a wrong one (write_site_note / delete_site_note).\n- (n1, 2026-10-10, codex, commit abc1234) Save is in the iframe.',
			none: undefined,
			secrets: [true, true, false],
		});
	});

	test('a note written in one pane is shown once to the next pane that opens the site, and only a verified caller can write', async () => {
		const store = new ParadisSiteNotesStore(join(folder, 'notes.json'), () => new Date('2026-10-10T03:00:00Z'));
		let verified = true;
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_siteNotes: store,
			_siteNotesShown: new Map<string, Set<string>>(),
			_paneSessions: new Map([[TOKEN, { agent: 'claude' }]]),
			_requireIngressLease: () => { },
			_classifyCaller: async () => verified ? 'pane' : 'unverified',
			_siteNoteSpace: async () => ({ key: '/repo' }),
			_defaultTabId: () => undefined,
			_bindingForKey: () => ({ pageInfo: { url: 'http://localhost:3000/orders' } }),
			_requireIngressLeaseCurrent: () => { },
			_paneRemoteAuthorityOf: () => undefined,
			_serverInstructions: () => undefined,
		}) as unknown as ISiteNotesInternals;
		const ok = { content: [{ type: 'text', text: 'page text' }] };
		const written = textOf(await service._siteNoteTool({ token: TOKEN }, 'write_site_note', { text: 'The filter button is called Search.' }));
		const ownPane = textOf(await service._withSiteNotesHint({ token: TOKEN }, 'get_text', {}, ok));
		const nextPane = textOf(await service._withSiteNotesHint({ token: 'next-pane' }, 'get_text', {}, ok));
		const nextPaneAgain = textOf(await service._withSiteNotesHint({ token: 'next-pane' }, 'click_by', {}, ok));
		const otherSite = textOf(await service._withSiteNotesHint({ token: 'next-pane' }, 'open_browser_tab', { url: 'https://example.com' }, ok));
		// 同じペインで新しいエージェントがつながったら、もう一度添える
		await service._dispatch({ token: 'next-pane' }, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		const newAgent = textOf(await service._withSiteNotesHint({ token: 'next-pane' }, 'get_text', {}, ok));
		verified = false;
		const refused = await service._siteNoteTool({ token: TOKEN }, 'write_site_note', { text: 'x' }) as { isError?: boolean };
		const secret = await (verified = true, service._siteNoteTool({ token: TOKEN }, 'write_site_note', { text: 'password: hunter2' })) as { isError?: boolean };
		assert.deepStrictEqual({
			written: written.startsWith('Saved the note ') && written.includes('(2026-10-10, claude)'),
			ownPane,
			nextPane: nextPane.includes('[Site notes for http://localhost:3000]') && nextPane.includes('The filter button is called Search.'),
			nextPaneAgain,
			otherSite,
			newAgent: newAgent.includes('The filter button is called Search.'),
			refused: refused.isError,
			secret: secret.isError,
		}, { written: true, ownPane: 'page text', nextPane: true, nextPaneAgain: 'page text', otherSite: 'page text', newAgent: true, refused: true, secret: true });
	});
});
