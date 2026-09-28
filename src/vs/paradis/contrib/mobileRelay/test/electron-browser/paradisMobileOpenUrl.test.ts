/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { paradisMobileOpenableUrl } from '../../electron-browser/paradisMobileOpenUrl.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';

suite('ParadisMobileOpenUrl', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only http(s) URLs with a host', () => {
		const values: unknown[] = ['http://localhost:3000/app', ' https://192.168.1.2/ ', 'javascript:alert(1)', 'file:///etc/passwd', 'http://', 'http://a\nb', 42, 'x'.repeat(5000)];
		assert.deepStrictEqual(values.map(paradisMobileOpenableUrl), ['http://localhost:3000/app', 'https://192.168.1.2/', undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('opens the URL in the built-in browser and answers, and refuses anything else', async () => {
		const executed: unknown[][] = [];
		const sent: string[] = [];
		const commandService = { executeCommand: async (...args: unknown[]) => { executed.push(args); } };
		const host: IParadisMobileRequestHost = {
			invokeFunction: fn => fn({ get: (id: unknown) => { assert.strictEqual(id, ICommandService); return commandService; } } as unknown as ServicesAccessor),
			resolveRoot: () => URI.file('/repo'),
			runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
			resolvePath: async () => undefined,
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(new TextDecoder().decode(payload)),
		};
		paradisDispatchMobileRequest('fs', { t: 'openUrl', id: 'r1', url: 'http://localhost:5173/' }, 'phone', host);
		paradisDispatchMobileRequest('fs', { t: 'openUrl', id: 'r2', url: 'javascript:alert(1)' }, 'phone', host);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ executed, sent }, {
			executed: [[BrowserViewCommandId.Open, 'http://localhost:5173/']],
			sent: ['{"error":"invalid url","id":"r2"}', '{"t":"openUrl","id":"r1"}'],
		});
	});
});
