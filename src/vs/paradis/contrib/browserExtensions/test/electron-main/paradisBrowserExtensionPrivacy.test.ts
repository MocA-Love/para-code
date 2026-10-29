/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_EXTENSION_API_CALL_URL, paradisDecodeExtensionWire, paradisEncodeExtensionWire, paradisExtensionApiUrl } from '../../common/paradisBrowserExtensionApiWire.js';
import { IParadisShimBridge, PARADIS_SHIM_PRIVACY_NAMESPACE, paradisInstallPrivacy } from '../../common/paradisBrowserExtensionShim.js';
import { ParadisApiSession, ParadisExtensionApiHost } from '../../electron-main/paradisBrowserExtensionApiHost.js';
import { IParadisPrivacyTab, ParadisBrowserExtensionPrivacy, ParadisWebRtcIpHandlingPolicy, paradisPrivacyUserTabs } from '../../electron-main/paradisBrowserExtensionPrivacy.js';

const VPN = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'b'.repeat(32);
const silentLog = { warn: () => { } };

class FakeTab implements IParadisPrivacyTab {
	readonly applied: ParadisWebRtcIpHandlingPolicy[] = [];
	setWebRTCIPHandlingPolicy(policy: ParadisWebRtcIpHandlingPolicy): void {
		this.applied.push(policy);
	}
}

suite('ParadisBrowserExtensionPrivacy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shim answers not_controllable for settings Para Code does not have, refuses to set them, and sends webRTCIPHandlingPolicy to main', async () => {
		const calls: [string, unknown[]][] = [];
		const bridge: IParadisShimBridge = {
			call: async (namespace, method, args) => {
				calls.push([`${namespace}.${method}`, args]);
				return { ok: true, value: method === 'get' ? { value: 'default', levelOfControl: 'controllable_by_this_extension' } : undefined };
			},
			listen: () => { },
			onEvent: () => { },
		};
		const page = { chrome: { runtime: { getManifest: () => ({ permissions: ['privacy'] }) } as Record<string, unknown> } as Record<string, unknown> };
		new Function('globalThis', 'bridge', 'namespace', `(${paradisInstallPrivacy.toString()})(bridge, namespace);`)(page, bridge, PARADIS_SHIM_PRIVACY_NAMESPACE);
		const privacy = page.chrome.privacy as Record<string, Record<string, Record<string, (...args: unknown[]) => unknown>>>;
		const passwordSaving = privacy.services.passwordSavingEnabled;
		const webRtc = privacy.network.webRTCIPHandlingPolicy;
		const runtime = page.chrome.runtime as Record<string, unknown>;
		const lastError = await new Promise(resolve => passwordSaving.set({ value: false }, () => resolve((runtime.lastError as { message: string } | undefined)?.message)));
		assert.deepStrictEqual({
			passwordSaving: await passwordSaving.get({}),
			setRejected: await (passwordSaving.set({ value: false }) as Promise<unknown>).then(() => 'resolved', (error: Error) => error.message),
			lastError,
			lastErrorAfter: runtime.lastError,
			webRtc: await webRtc.get({}),
			setWebRtc: await webRtc.set({ value: 'disable_non_proxied_udp' }),
			calls,
		}, {
			passwordSaving: { value: false, levelOfControl: 'not_controllable' },
			setRejected: 'Para Code does not have this setting, so browser extensions cannot control it',
			lastError: 'Para Code does not have this setting, so browser extensions cannot control it',
			lastErrorAfter: undefined,
			webRtc: { value: 'default', levelOfControl: 'controllable_by_this_extension' },
			setWebRtc: undefined,
			calls: [[`${PARADIS_SHIM_PRIVACY_NAMESPACE}.get`, []], [`${PARADIS_SHIM_PRIVACY_NAMESPACE}.set`, [{ value: 'disable_non_proxied_udp' }]]],
		});
	});

	test('applies webRTCIPHandlingPolicy to the place\'s user tabs for real, never to agent tabs, and stops when the extension goes away', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-privacy-'));
		let handler: ((request: Request) => Promise<Response>) | undefined;
		const session = {
			storagePath: '/tmp/session',
			protocol: { handle: (_scheme: string, next: (request: Request) => Promise<Response>) => { handler = next; }, unhandle: () => { handler = undefined; } },
			extensions: { getExtension: (id: string) => id === VPN || id === OTHER ? { id, version: '1.0', manifest: { manifest_version: 3, permissions: ['privacy'] }, name: id, path: '/x' } : null, on: () => undefined, removeListener: () => undefined },
			serviceWorkers: { startWorkerForScope: async () => { throw new Error('none'); }, getWorkerFromVersionID: () => undefined, on: () => undefined, removeListener: () => undefined },
		} as unknown as ParadisApiSession;
		const host = new ParadisExtensionApiHost(silentLog);
		const userTab = new FakeTab();
		const agentTab = new FakeTab();
		const otherPlaceTab = new FakeTab();
		const views = [
			{ webContents: Object.assign(userTab, { session: 'default-session' }), isAgentTab: () => false },
			{ webContents: Object.assign(agentTab, { session: 'default-session' }), isAgentTab: () => true },
			{ webContents: Object.assign(otherPlaceTab, { session: 'profile-session' }), isAgentTab: () => false },
		];
		const enabled = new Set([VPN, OTHER]);
		const privacy = new ParadisBrowserExtensionPrivacy(host, join(root, 'privacy.json'), silentLog, {
			userTabsIn: place => paradisPrivacyUserTabs(views, sessionOf => sessionOf === 'default-session' ? 'default' : sessionOf === 'profile-session' ? 'profile:0123456789ab' : undefined, place),
			isEnabledIn: (_place, id) => enabled.has(id),
		});
		const attached = host.attachSession(session, 'default');
		const call = async (extensionId: string, method: string, args: unknown[]) => {
			const request = new Request(paradisExtensionApiUrl(PARADIS_EXTENSION_API_CALL_URL, host.tokenFor(extensionId), 'worker'), { method: 'POST', body: paradisEncodeExtensionWire({ request: { type: 'call', namespace: PARADIS_SHIM_PRIVACY_NAMESPACE, method, args } }) });
			Object.defineProperty(request, 'initiatorOrigin', { value: `chrome-extension://${extensionId}` });
			return paradisDecodeExtensionWire(await (await handler!(request)).text());
		};
		try {
			const set = await call(VPN, 'set', [{ value: 'disable_non_proxied_udp' }]);
			const ownView = await call(VPN, 'get', []);
			const otherView = await call(OTHER, 'get', []);
			const invalid = await call(VPN, 'set', [{ value: 'leak_everything' }]);
			const incognito = await call(VPN, 'set', [{ value: 'default', scope: 'incognito_persistent' }]);
			// 起動し直しても、開いたタブに効かせる値は残る
			const restarted = new ParadisBrowserExtensionPrivacy(new ParadisExtensionApiHost(silentLog), join(root, 'privacy.json'), silentLog, { userTabsIn: () => [], isEnabledIn: (_place, id) => enabled.has(id) });
			await restarted.load();
			const afterRestart = restarted.effective('default');
			// 拡張機能を無効にすると、その値は使わない
			enabled.delete(VPN);
			privacy.apply('default');
			const afterDisable = privacy.effective('default');
			enabled.add(VPN);
			await privacy.forgetExtension(VPN);
			assert.deepStrictEqual({
				set, ownView, otherView, invalid, incognito, afterRestart, afterDisable,
				userTab: userTab.applied, agentTab: agentTab.applied, otherPlaceTab: otherPlaceTab.applied,
				afterForget: privacy.effective('default'),
			}, {
				set: { ok: true },
				ownView: { ok: true, value: { value: 'disable_non_proxied_udp', levelOfControl: 'controlled_by_this_extension' } },
				otherView: { ok: true, value: { value: 'disable_non_proxied_udp', levelOfControl: 'controlled_by_other_extensions' } },
				invalid: { ok: false, error: 'Invalid value for webRTCIPHandlingPolicy: leak_everything' },
				incognito: { ok: false, error: 'Para Code has no incognito windows, so only the regular scope can be set' },
				afterRestart: { value: 'disable_non_proxied_udp', extensionId: VPN },
				afterDisable: { value: 'default' },
				// 利用者のタブには本当に効かせる。エージェントのタブ・ほかの場所のタブには効かせない
				userTab: ['disable_non_proxied_udp', 'default', 'default'],
				agentTab: [],
				otherPlaceTab: [],
				afterForget: { value: 'default' },
			});
		} finally {
			attached.dispose();
			host.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
