/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IParadisAgentBrowserBindingModel } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisBrowserProfilesService } from '../../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import { IParadisHubHost } from '../../../paradisHub/electron-browser/paradisHub.js';
import { IParadisBrowserExtensionView, PARADIS_DEFAULT_EXTENSION_PROFILE } from '../../common/paradisBrowserExtensions.js';
import { ParadisBrowserExtensionsArea } from '../../electron-browser/paradisBrowserExtensionsArea.js';

function extension(id: string, name: string): IParadisBrowserExtensionView {
	return { id, name, version: '1.0.0', manifestVersion: 3, source: 'webstore', sourcePath: '', path: `/x/${id}`, installedAt: 0, touchesPages: false, enabledIn: [PARADIS_DEFAULT_EXTENSION_PROFILE], allowedOnRemote: false };
}

suite('ParadisBrowserExtensionsArea', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createArea(extensions: IParadisBrowserExtensionView[]) {
		const doc = mainWindow.document;
		const containers = { nav: doc.body.appendChild(doc.createElement('nav')), content: doc.body.appendChild(doc.createElement('div')), header: doc.createElement('div') };
		store.add({ dispose: () => { containers.nav.remove(); containers.content.remove(); } });
		const state = { active: true, setting: true, extensions };
		const channel: IChannel = {
			call: async <T>(command: string) => (command === 'getState' ? state : command === 'getWorkerLog' ? [] : undefined) as T,
			listen: <T>() => Event.None as Event<T>,
		};
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IMainProcessService, { getChannel: () => channel } as Partial<IMainProcessService>);
		instantiationService.stub(IParadisBrowserProfilesService, { list: () => [], onDidChangeProfiles: Event.None } as Partial<IParadisBrowserProfilesService>);
		instantiationService.stub(IFileDialogService, {});
		instantiationService.stub(IConfigurationService, { getValue: () => undefined } as Partial<IConfigurationService>);
		instantiationService.stub(INativeHostService, {});
		instantiationService.stub(IParadisAgentBrowserBindingModel, { bindings: [] } as Partial<IParadisAgentBrowserBindingModel>);
		instantiationService.stub(IContextViewService, {});
		const host: IParadisHubHost = { close: () => { }, open: () => { } };
		store.add(instantiationService.createInstance(ParadisBrowserExtensionsArea, containers, host));
		return containers;
	}

	// Q544: 背景の処理がある拡張機能は、設定と権限を左の列、ログを右の列に置く。無いものは 1 列のまま
	test('puts the service worker log in a right column only for extensions that have one', async () => {
		const containers = createArea([{ ...extension('a', 'Alpha'), worker: { running: false } }, extension('b', 'Beta')]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const layout = () => {
			const detail = containers.content.querySelector<HTMLElement>('.pbe-detail')!;
			return {
				twoColumns: detail.classList.contains('pbe-detail-2col'),
				children: [...detail.children].map(child => child.className),
				log: [...detail.querySelectorAll('.pbe-log')].map(log => log.closest('.pbe-col-log') !== null),
			};
		};
		const steps = [layout()];
		containers.nav.querySelectorAll<HTMLElement>('.pbe-list-row')[1].click();
		steps.push(layout());
		assert.deepStrictEqual(steps, [
			{ twoColumns: true, children: ['pbe-col-main', 'pbe-col-log'], log: [true] },
			{ twoColumns: false, children: ['pbe-detail-header', 'pbe-detail-actions', 'pbe-confirm-host', 'pbe-callout is-error', 'pbe-section', 'pbe-section'], log: [] },
		]);
	});

	// 一覧は選んでいる行だけが Tab で止まるので、上下の矢印・Home・End で隣の行へ移って選べること
	test('moves the selection through the installed list with the arrow keys, Home and End', async () => {
		const doc = mainWindow.document;
		const containers = createArea([extension('a', 'Alpha'), extension('b', 'Beta'), extension('c', 'Gamma')]);
		await new Promise(resolve => setTimeout(resolve, 0));

		const selected = () => {
			const rows = [...containers.nav.querySelectorAll<HTMLElement>('.pbe-list-row')];
			const row = rows.find(candidate => candidate.getAttribute('aria-selected') === 'true');
			return `${row?.querySelector('.pbpm-name')?.textContent}:${row === doc.activeElement}:${rows.map(candidate => candidate.tabIndex).join(',')}`;
		};
		const press = (key: string) => doc.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
		containers.nav.querySelector<HTMLElement>('.pbe-list-row')!.focus();
		const steps = [selected()];
		for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
			press(key);
			steps.push(`${key} ${selected()}`);
		}
		assert.deepStrictEqual(steps, [
			'Alpha:true:0,-1,-1',
			'ArrowDown Beta:true:-1,0,-1',
			'ArrowDown Gamma:true:-1,-1,0',
			'ArrowDown Gamma:true:-1,-1,0',
			'ArrowUp Beta:true:-1,0,-1',
			'Home Alpha:true:0,-1,-1',
			'End Gamma:true:-1,-1,0',
		]);
	});
});
