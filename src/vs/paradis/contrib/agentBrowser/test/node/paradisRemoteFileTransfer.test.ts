/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname, extname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMcpOwningWindowResult } from '../../common/paradisMcpToolProvider.js';
import { PARADIS_REMOTE_FILE_CHECK_WRITE_METHOD, PARADIS_REMOTE_FILE_READ_METHOD, PARADIS_REMOTE_FILE_WRITE_METHOD, PARADIS_REMOTE_FILE_WRITE_TEMPORARY_METHOD } from '../../common/paradisRemoteFileBridge.js';
import { ParadisRemoteFileTransfer, paradisDescribeToolsForRemotePane, paradisRemoteFileToolDirection } from '../../node/paradisRemoteFileTransfer.js';

interface IResult {
	readonly content: readonly { readonly type: string; readonly text: string }[];
	readonly isError?: boolean;
}

function texts(result: unknown): string {
	return (result as IResult).content.map(part => part.text).join('\n');
}

/** The renderer side: a remote file system held in memory. */
class FakeWindow {
	readonly files = new Map<string, Uint8Array>();
	readonly calls: string[] = [];
	refuseWrite = false;

	async call<T>(method: string, args: unknown[]): Promise<ParadisMcpOwningWindowResult<T>> {
		this.calls.push(method);
		const path = args[0] as string;
		switch (method) {
			case PARADIS_REMOTE_FILE_CHECK_WRITE_METHOD:
				return { ok: true, value: (this.refuseWrite ? { ok: false, reason: 'outsideAllowedFolders' } : { ok: true }) as T };
			case PARADIS_REMOTE_FILE_WRITE_METHOD:
				this.files.set(path, (args[1] as VSBuffer).buffer);
				return { ok: true, value: { ok: true, path } as T };
			case PARADIS_REMOTE_FILE_WRITE_TEMPORARY_METHOD:
				this.files.set(`/home/example/.para-code/browser-files/${path}`, (args[1] as VSBuffer).buffer);
				return { ok: true, value: { ok: true, path: `/home/example/.para-code/browser-files/${path}`, userFolder: '/home/example/.para-code/browser-files' } as T };
			case PARADIS_REMOTE_FILE_READ_METHOD: {
				const data = this.files.get(path);
				return { ok: true, value: (data === undefined ? { ok: false, reason: 'notFound' } : { ok: true, data: VSBuffer.wrap(data), name: path.split('/').pop() }) as T };
			}
		}
		return { ok: false, error: 'unknown method' };
	}
}

/** Behaves like the vendored saveFile: replaces the extension and reports the saved path. */
async function fakeScreenshot(args: Record<string, unknown>): Promise<unknown> {
	const requested = args.filePath as string;
	const saved = `${requested.slice(0, requested.length - extname(requested).length)}.png`;
	await fs.mkdir(dirname(saved), { recursive: true });
	await fs.writeFile(saved, 'png-bytes');
	return { content: [{ type: 'text', text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${saved}.` }] };
}

suite('ParadisRemoteFileTransfer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let transfer: ParadisRemoteFileTransfer;
	let window: FakeWindow;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transfer-test-'));
		transfer = new ParadisRemoteFileTransfer(() => root);
		window = new FakeWindow();
		restricted = [];
	});

	teardown(async () => {
		transfer.dispose();
		await fs.rm(root, { recursive: true, force: true });
	});

	let restricted: string[];
	const host = () => ({
		callWindow: <T>(method: string, args: unknown[]) => window.call<T>(method, args),
		restrictFolder: async (folder: string) => { restricted.push(folder); },
	});

	test('only filePath of take_screenshot, take_snapshot and upload_file is bridged', () => {
		assert.deepStrictEqual([
			paradisRemoteFileToolDirection('take_screenshot', ['filePath']),
			paradisRemoteFileToolDirection('take_snapshot', ['filePath']),
			paradisRemoteFileToolDirection('upload_file', ['filePath']),
			paradisRemoteFileToolDirection('evaluate_script', ['filePath']),
			paradisRemoteFileToolDirection('take_screenshot', ['filePath', 'otherPath']),
		], ['output', 'output', 'input', undefined, undefined]);
	});

	test('writes a screenshot back to the remote path, with the extension the tool chose, and leaves no local file', async () => {
		const result = await transfer.callTool('take_screenshot', 'output', { filePath: '/home/example/shot.jpg', format: 'png' }, host(), fakeScreenshot);
		assert.deepStrictEqual({
			isError: (result as IResult).isError === true,
			reportsRemotePath: texts(result).includes('Saved screenshot to /home/example/shot.png.'),
			hidesLocalPath: texts(result).includes(root),
			remote: [...window.files.keys()],
			content: new TextDecoder().decode(window.files.get('/home/example/shot.png')),
			localLeftovers: await fs.readdir(root),
			// Written outside the user folder (no mark from the renderer): no chmod
			restricted,
		}, {
			isError: false,
			reportsRemotePath: true,
			hidesLocalPath: false,
			remote: ['/home/example/shot.png'],
			content: 'png-bytes',
			localLeftovers: [],
			restricted: [],
		});
	});

	test('refuses before taking the screenshot when the remote path may not be written, and rejects relative paths', async () => {
		window.refuseWrite = true;
		let called = 0;
		const refused = await transfer.callTool('take_screenshot', 'output', { filePath: '/etc/shot.png' }, host(), async args => { called++; return fakeScreenshot(args); });
		const relative = await transfer.callTool('take_snapshot', 'output', { filePath: 'snap.txt' }, host(), async args => { called++; return fakeScreenshot(args); });
		assert.deepStrictEqual({
			called,
			refused: [(refused as IResult).isError, texts(refused).includes('outside the folders')],
			relative: [(relative as IResult).isError, texts(relative).includes('absolute path')],
		}, {
			called: 0,
			refused: [true, true],
			relative: [true, true],
		});
	});

	test('reads an upload from the remote machine into a local temporary copy that the tool receives', async () => {
		window.files.set('/home/example/report.csv', new TextEncoder().encode('a,b'));
		let received: string | undefined;
		const result = await transfer.callTool('upload_file', 'input', { uid: '1_2', filePath: '/home/example/report.csv' }, host(), async args => {
			received = args.filePath as string;
			return { content: [{ type: 'text', text: `File uploaded from ${received}.` }] };
		});
		const missing = await transfer.callTool('upload_file', 'input', { uid: '1_2', filePath: '/home/example/missing.csv' }, host(), async () => ({ content: [] }));
		assert.deepStrictEqual({
			localCopyInRoot: received?.startsWith(root),
			localName: received?.endsWith('/report.csv'),
			localContent: received === undefined ? undefined : await fs.readFile(received, 'utf8'),
			text: texts(result),
			missing: [(missing as IResult).isError, texts(missing).includes('does not exist')],
		}, {
			localCopyInRoot: true,
			localName: true,
			localContent: 'a,b',
			text: 'File uploaded from /home/example/report.csv.',
			missing: [true, true],
		});
	});

	test('copies a saved download to the user folder on the remote machine and makes that folder private', async () => {
		const local = join(root, 'Example Page.pdf');
		await fs.writeFile(local, 'pdf');
		assert.deepStrictEqual({
			copied: await transfer.deliverToRemoteTemporaryFolder(local, host()),
			restricted,
			missing: await transfer.deliverToRemoteTemporaryFolder(join(root, 'missing.pdf'), host()),
		}, {
			copied: { ok: true, path: '/home/example/.para-code/browser-files/Example Page.pdf' },
			restricted: ['/home/example/.para-code/browser-files'],
			missing: { ok: false, message: 'the saved file could not be read on the machine running Para Code' },
		});
	});

	test('reports a local temporary folder that cannot be created as a tool error instead of throwing', async () => {
		const broken = new ParadisRemoteFileTransfer(() => join(root, 'does-not-exist'));
		try {
			const result = await broken.callTool('take_screenshot', 'output', { filePath: '/home/example/repo/shot.png' }, host(), fakeScreenshot);
			assert.deepStrictEqual([(result as IResult).isError, texts(result).includes('could not prepare a temporary folder')], [true, true]);
		} finally {
			broken.dispose();
		}
	});

	test('describes path arguments as paths on the remote machine', () => {
		const tools = paradisDescribeToolsForRemotePane([
			{ name: 'take_screenshot', inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'relative to cwd' }, uid: { type: 'string', description: 'uid' } } } },
			{ name: 'evaluate_script', inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'relative to cwd' } } } },
			{ name: 'save_page_as_pdf', description: 'Print the page.', inputSchema: { type: 'object', properties: {} } },
			{ name: 'click', description: 'Click.', inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'uid' } } } },
		]);
		const description = (index: number, key: string) => ((tools[index].inputSchema as { properties: Record<string, { description: string }> }).properties[key]).description;
		assert.deepStrictEqual({
			screenshot: description(0, 'filePath').startsWith('Absolute path on the machine this agent runs on'),
			uidKept: description(0, 'uid'),
			evaluate: description(1, 'filePath').startsWith('Not available to agents in a remote window'),
			pdf: tools[2].description?.includes('also copied to ~/.para-code/browser-files on your machine'),
			click: tools[3],
		}, {
			screenshot: true,
			uidKept: 'uid',
			evaluate: true,
			pdf: true,
			click: { name: 'click', description: 'Click.', inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'uid' } } } },
		});
	});
});
