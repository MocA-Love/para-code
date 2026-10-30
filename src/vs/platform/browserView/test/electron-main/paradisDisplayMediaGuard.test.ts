/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PermissionCategory } from '../../common/browserPermissions.js';
import { BrowserViewStorageScope, IBrowserViewPermissionRequestEvent } from '../../common/browserView.js';
import type { BrowserSession } from '../../electron-main/browserSession.js';
import { BrowserSessionPermissions } from '../../electron-main/browserSessionPermissions.js';

type PermissionRequestHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>;
type PermissionCheckHandler = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>;

suite('ParadisDisplayMediaGuard', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createPermissions() {
		let requestHandler: PermissionRequestHandler | null = null;
		let checkHandler: PermissionCheckHandler | null = null;
		const electronSession = new class extends mock<Electron.Session>() {
			override setPermissionRequestHandler(handler: PermissionRequestHandler | null): void {
				requestHandler = handler;
			}
			override setPermissionCheckHandler(handler: PermissionCheckHandler | null): void {
				checkHandler = handler;
			}
			override on(): this {
				return this;
			}
		};
		const permissions = disposables.add(new BrowserSessionPermissions(new class extends mock<BrowserSession>() {
			override readonly storageScope = BrowserViewStorageScope.Ephemeral;
		}));
		const webContents = new class extends mock<Electron.WebContents>() {
			override getURL(): string {
				return 'https://site.example/page';
			}
		};
		permissions.configure(electronSession);
		const request = (details: Partial<Electron.MediaAccessPermissionRequest>, permission: Parameters<PermissionRequestHandler>[1] = 'media') => new Promise<boolean>(resolve => {
			assert.ok(requestHandler);
			requestHandler(webContents, permission, resolve, { isMainFrame: true, mediaTypes: [], ...details } as Electron.MediaAccessPermissionRequest);
		});
		const check = (details: Partial<Electron.PermissionCheckHandlerHandlerDetails>, permission: Parameters<PermissionCheckHandler>[1] = 'media') => {
			assert.ok(checkHandler);
			return checkHandler(webContents, permission, 'https://site.example', { isMainFrame: true, ...details } as Electron.PermissionCheckHandlerHandlerDetails);
		};
		return { permissions, request, check };
	}

	test('refuses screen capture from every page and frame, even where the camera and microphone are allowed', async () => {
		const { permissions, request, check } = createPermissions();
		const site = 'https://site.example';
		const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
		permissions.set(site, [{ category: PermissionCategory.Camera, state: 'allow' }, { category: PermissionCategory.Microphone, state: 'allow' }]);
		permissions.set(extension, [{ category: PermissionCategory.Camera, state: 'allow' }, { category: PermissionCategory.Microphone, state: 'allow' }]);
		assert.deepStrictEqual({
			cameraAndMicrophone: await request({ requestingUrl: `${site}/page`, securityOrigin: `${site}/`, mediaTypes: ['video', 'audio'] }),
			// getDisplayMedia と、生の画面 id の getUserMedia は、どちらも種類の無い media として届く
			siteScreen: await request({ requestingUrl: `${site}/page`, securityOrigin: `${site}/` }),
			siteAboutBlankChild: await request({ requestingUrl: 'about:blank', securityOrigin: `${site}/`, isMainFrame: false }),
			siteBlobChild: await request({ requestingUrl: `blob:${site}/0a1b2c3d`, securityOrigin: `${site}/`, isMainFrame: false }),
			extensionPage: await request({ requestingUrl: `${extension}/rec.html`, securityOrigin: `${extension}/` }),
			extensionAboutBlankChild: await request({ requestingUrl: 'about:blank', securityOrigin: `${extension}/`, isMainFrame: false }),
			extensionBlobChild: await request({ requestingUrl: `blob:${extension}/0a1b2c3d`, securityOrigin: `${extension}/`, isMainFrame: false }),
			displayCapture: await request({ requestingUrl: `${site}/page`, securityOrigin: `${site}/` }, 'display-capture'),
			// permissions.query などの確認も、取る求めと同じ答えにする
			checkCamera: check({ requestingUrl: `${site}/page`, securityOrigin: `${site}/`, mediaType: 'video' }),
			checkMicrophone: check({ requestingUrl: `${site}/page`, securityOrigin: `${site}/`, mediaType: 'audio' }),
			checkScreen: check({ requestingUrl: `${site}/page`, embeddingOrigin: `${site}/` }),
			checkScreenChild: check({ requestingUrl: 'about:blank', securityOrigin: `${site}/`, isMainFrame: false }),
		}, {
			cameraAndMicrophone: true,
			siteScreen: false, siteAboutBlankChild: false, siteBlobChild: false,
			extensionPage: false, extensionAboutBlankChild: false, extensionBlobChild: false,
			displayCapture: false,
			checkCamera: true, checkMicrophone: true, checkScreen: false, checkScreenChild: false,
		});
	});

	test('still asks before a site uses the camera and microphone', async () => {
		const { permissions, request } = createPermissions();
		const prompts: IBrowserViewPermissionRequestEvent[] = [];
		disposables.add(permissions.onDidRequestPermission(event => {
			prompts.push(event.request);
			event.claim();
			queueMicrotask(() => permissions.set(event.request.origin, [{ category: event.request.category, state: 'allow' }]));
		}));
		const origin = 'https://meet.example';
		const granted = await request({ requestingUrl: `${origin}/room`, securityOrigin: `${origin}/`, mediaTypes: ['video', 'audio'] });
		assert.deepStrictEqual({ granted, prompts }, {
			granted: true,
			prompts: [{ origin, category: PermissionCategory.Camera }, { origin, category: PermissionCategory.Microphone }],
		});
	});
});
