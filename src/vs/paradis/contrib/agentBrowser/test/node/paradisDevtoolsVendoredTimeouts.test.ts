/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// vendored chrome-devtools-mcp の PARA-PATCH（q.html Q393・Q394）を、vendored のモジュールをそのまま読み込んで確かめる。
// vendored は `node:` のモジュールを読む ESM なので、テストの窓（renderer）では読み込めない。子の node で動かし、結果を
// JSON で受け取る。ページは偽物で、答えない評価は解決しない Promise で表す。

import assert from 'assert';
import { execFile } from 'child_process';
import { FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const BUILD = FileAccess.asFileUri('vs/paradis/contrib/agentBrowser/node/media/chrome-devtools-mcp/build/src').toString();

/** 偽のページなどの部品（子の node で、各シナリオの前に置く）。 */
const PRELUDE = `
const BUILD = ${JSON.stringify(BUILD)};
const never = () => new Promise(() => { });
class FakeEmitter {
	listeners = new Map();
	on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
	off(event, listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(candidate => candidate !== listener)); }
	count(event) { return this.listeners.get(event)?.length ?? 0; }
	emit(event, value) { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
}
const fakeResponse = (lines = []) => ({ appendResponseLine: line => lines.push(line), setIncludePages() { }, setListThirdPartyDeveloperTools() { }, setListWebMcpTools() { }, attachWaitForResult() { } });
`;

/** シナリオを子の node で動かし、`out` に入れた値を返す。 */
function runInNode(scenario: string): Promise<unknown> {
	const source = `${PRELUDE}\nconst out = await (async () => {\n${scenario}\n})();\nprocess.stdout.write(JSON.stringify(out));\nprocess.exit(0);`;
	return new Promise((resolve, reject) => {
		execFile(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${error.message}\n${stderr}`));
				return;
			}
			resolve(JSON.parse(stdout));
		});
	});
}

suite('Paradis vendored chrome-devtools-mcp timeouts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ToolHandler gives up after paraCodeTimeoutMs plus the grace, counted from holding the mutex, and frees the mutex once', async () => {
		const out = await runInNode(`
			const { ToolHandler } = await import(BUILD + '/ToolHandler.js');
			const { Mutex } = await import(BUILD + '/Mutex.js');
			const { zod } = await import(BUILD + '/third_party/index.js');
			ToolHandler.paraCodeTimeoutGraceMs = 0;
			const mutex = new Mutex();
			const context = async () => ({ detectOpenDevToolsWindows: async () => { } });
			const tool = (name, handler) => new ToolHandler({ name, schema: { paraCodeTimeoutMs: zod.number().optional() }, handler, annotations: { category: 'debugging' } }, {}, context, mutex);
			const hanging = tool('evaluate_script', () => never());
			const quick = tool('take_snapshot', async (_request, response) => response.appendResponseLine('ok'));
			const gaveUp = await hanging.handle({ paraCodeTimeoutMs: 30 });
			const next = await quick.handle({ paraCodeTimeoutMs: 30 });
			// 前の呼び出しが mutex を握っている間の待ちは数えない（後ろの呼び出しは前が諦めてから動き、締め切りより先に終わる）
			const first = hanging.handle({ paraCodeTimeoutMs: 60 });
			const queued = await quick.handle({ paraCodeTimeoutMs: 20 });
			await first;
			const plain = await quick.handle({});
			return { gaveUp: [gaveUp.isError, gaveUp.content[0].text], next: next.content[0].text, queued: queued.content[0].text, plain: plain.content[0].text };
		`);
		assert.deepStrictEqual(out, {
			gaveUp: [true, 'PARA_BROWSER_PAGE_UNRESPONSIVE: evaluate_script did not finish within 30 ms.'],
			next: 'ok',
			queued: 'ok',
			plain: 'ok',
		});
	});

	// レビューの指摘（HIGH）: 諦めた evaluate_script の既定 accept のダイアログの handler が残ると、次の click が開いた
	// confirm を勝手に承認する。締め切りは waitForEventsAfterAction の中で失敗させ、helper に handler を外させる
	test('evaluate_script gives up inside the action, so its dialog handler is removed and a later dialog is not accepted', async () => {
		const out = await runInNode(`
			const { evaluateScript } = await import(BUILD + '/tools/script.js');
			const { WaitForHelper } = await import(BUILD + '/WaitForHelper.js');
			const client = new FakeEmitter();
			const pptrPage = Object.assign(new FakeEmitter(), { url: () => 'https://example.com/', _client: () => client, evaluateHandle: () => never() });
			const mcpPage = { pptrPage, waitForEventsAfterAction: (action, options) => new WaitForHelper(pptrPage, 1, 1).waitForEventsAfterAction(action, options) };
			let failure;
			try {
				await evaluateScript({}).handler({ params: { function: '() => document.title', paraCodeTimeoutMs: 30 } }, fakeResponse(), { getSelectedMcpPage: () => mcpPage });
			} catch (error) {
				failure = error.message;
			}
			let accepted = 0;
			pptrPage.emit('dialog', { accept: () => { accepted++; }, dismiss: () => { } });
			return { failure, dialogListeners: pptrPage.count('dialog'), accepted };
		`);
		assert.deepStrictEqual(out, {
			failure: 'PARA_BROWSER_PAGE_UNRESPONSIVE: evaluate_script did not finish within 30 ms.',
			dialogListeners: 0,
			accepted: 0,
		});
	});

	test('navigate_page reports a timeout after the main frame committed as still loading, and keeps the upstream line otherwise', async () => {
		const out = await runInNode(`
			const { navigatePage } = await import(BUILD + '/tools/pages.js');
			const tool = navigatePage({});
			const run = async (type, frames) => {
				const client = new FakeEmitter();
				const commitThenTimeOut = async () => {
					for (const frame of frames) { client.emit('Page.frameNavigated', { frame }); }
					throw Object.assign(new Error('Navigation timeout of 10000 ms exceeded'), { name: 'TimeoutError' });
				};
				const pptrPage = Object.assign(new FakeEmitter(), { _client: () => client, url: () => 'http://localhost:5173/app', goto: commitThenTimeOut, reload: commitThenTimeOut });
				const page = { pptrPage, waitForEventsAfterAction: async action => { await action(); }, clearDialog() { } };
				const lines = [];
				await tool.handler({ page, params: { type, url: 'http://localhost:5173/' } }, fakeResponse(lines), {});
				return [lines.join('\\n'), client.count('Page.frameNavigated')];
			};
			return { committed: await run('url', [{ id: 'main' }]), childOnly: await run('url', [{ id: 'child', parentId: 'main' }]), reloaded: await run('reload', [{ id: 'main' }]) };
		`) as Record<string, [string, number]>;
		assert.deepStrictEqual({
			committed: [out.committed[0].startsWith('Navigated to http://localhost:5173/app, but the page had not finished loading'), out.committed[1]],
			childOnly: out.childOnly,
			reloaded: out.reloaded[0].startsWith('Reloaded the page, but the page had not finished loading'),
		}, {
			committed: [true, 0],
			childOnly: ['Unable to navigate in the selected page: Navigation timeout of 10000 ms exceeded.', 0],
			reloaded: true,
		});
	});

	test('the stable-DOM wait after an action gives up on a page that does not answer', async () => {
		// 落ち着き待ちの上限は 3000 ms × CPU の倍率。倍率を小さくして短く確かめる
		const out = await runInNode(`
			const { WaitForHelper } = await import(BUILD + '/WaitForHelper.js');
			const pptrPage = Object.assign(new FakeEmitter(), { url: () => 'https://example.com/', _client: () => new FakeEmitter(), evaluateHandle: () => never() });
			const started = Date.now();
			const result = await new WaitForHelper(pptrPage, 0.01, 1).waitForEventsAfterAction(async () => { });
			return { result, quick: Date.now() - started < 1000 };
		`);
		assert.deepStrictEqual(out, { result: {}, quick: true });
	});
});
