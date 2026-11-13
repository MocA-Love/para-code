/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { AuthInfo, Credentials, IRequestService } from '../../../../../platform/request/common/request.js';
import { IParadisServiceStatusEntry, IParadisServiceStatusSnapshot, PARADIS_SERVICE_STATUS_SETTING_ENABLED, PARADIS_SERVICE_STATUS_SOURCES, ParadisServiceStatusProvider, ParadisServiceStatusSeverity } from '../../common/paradisServiceStatus.js';
import { ParadisServiceStatusPopover } from '../../electron-browser/paradisServiceStatusPopover.js';
import { createParadisServiceStatusWidget } from '../../electron-browser/paradisServiceStatusWidget.js';

function entry(provider: ParadisServiceStatusProvider, severity: ParadisServiceStatusSeverity, description: string): IParadisServiceStatusEntry {
	return { provider, severity, description, fetchedAt: 1_000, error: undefined };
}

function snapshot(openaiSeverity: ParadisServiceStatusSeverity): IParadisServiceStatusSnapshot {
	return {
		generatedAt: Date.now(),
		entries: {
			claude: entry('claude', 'ok', 'All Systems Operational'),
			codex: entry('codex', openaiSeverity, openaiSeverity === 'ok' ? 'All Systems Operational' : 'Partially Degraded Service'),
			github: entry('github', 'ok', 'All Systems Operational'),
		},
	};
}

suite('ParadisServiceStatusPopover', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: HTMLElement;
	let anchor: HTMLButtonElement;
	let closes: boolean[];
	let refreshes: number;

	setup(() => {
		root = document.createElement('div');
		document.body.appendChild(root);
		anchor = document.createElement('button');
		root.appendChild(anchor);
		closes = [];
		refreshes = 0;
	});

	teardown(() => root.remove());

	function open(initial: IParadisServiceStatusSnapshot | undefined): ParadisServiceStatusPopover {
		return store.add(new ParadisServiceStatusPopover(
			anchor,
			{ snapshot: initial, onClose: restoreFocus => closes.push(restoreFocus), onRefresh: () => refreshes++ },
			upcastPartial<ILayoutService>({ activeContainer: root }),
			upcastPartial<IOpenerService>({ open: async () => true }),
			upcastPartial<ICommandService>({ executeCommand: async () => undefined }),
			NullHoverService,
		));
	}

	function rows(): string[] {
		return [...root.querySelectorAll('.pssp-row')].map(row => [
			row.querySelector('.pssp-name')?.textContent,
			row.querySelector('.paradis-service-status-dot')?.className.replace('paradis-service-status-dot ', ''),
			row.querySelector('.pssp-level')?.textContent,
			row.querySelector('.pssp-desc')?.textContent ?? '-',
		].join(' | '));
	}

	test('lists the three services with the status page wording only while something is wrong', () => {
		open(snapshot('minor'));
		assert.deepStrictEqual(rows(), [
			'Claude | ok | 正常 | -',
			'OpenAI | minor | 軽微な障害 | Partially Degraded Service',
			'GitHub | ok | 正常 | -',
		]);
	});

	test('keeps the focus on the pressed link when a refreshed snapshot redraws the popover, and asks to restore the focus on Escape', () => {
		const popover = open(snapshot('minor'));
		const refresh = root.querySelector<HTMLElement>('[data-focus-key="refresh"]')!;
		refresh.focus();
		refresh.click();
		popover.updateSnapshot(snapshot('ok'));
		const focused = document.activeElement as HTMLElement | null;
		focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		assert.deepStrictEqual({
			refreshes,
			focusKey: focused?.dataset.focusKey,
			stillInPopover: !!focused?.closest('.paradis-service-status-popover'),
			redrawn: rows()[1],
			closes,
		}, {
			refreshes: 1,
			focusKey: 'refresh',
			stillInPopover: true,
			redrawn: 'OpenAI | ok | 正常 | -',
			closes: [true],
		});
	});
});

/** OpenAI だけ軽微な障害を返す statuspage。 */
class StatusPageRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;
	readonly onDidCompleteRequest = Event.None;
	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		const minor = options.url === PARADIS_SERVICE_STATUS_SOURCES.codex.apiUrl;
		const body = JSON.stringify({ status: minor ? { indicator: 'minor', description: 'Partially Degraded Service' } : { indicator: 'none', description: 'All Systems Operational' } });
		return { res: { headers: {}, statusCode: 200 }, stream: bufferToStream(VSBuffer.fromString(body)) };
	}
	async resolveProxy(_url: string): Promise<string | undefined> { return undefined; }
	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> { return undefined; }
	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> { return undefined; }
	async loadCertificates(): Promise<string[]> { return []; }
}

suite('ParadisServiceStatusWidget', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows one chip per service with its state dot, and moves the popover to the pressed chip', async () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		try {
			const instantiationService = store.add(new TestInstantiationService());
			instantiationService.stub(IRequestService, new StatusPageRequestService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService({ [PARADIS_SERVICE_STATUS_SETTING_ENABLED]: true }));
			instantiationService.stub(IHoverService, NullHoverService);
			instantiationService.stub(ILayoutService, upcastPartial<ILayoutService>({ activeContainer: container }));
			instantiationService.stub(IOpenerService, upcastPartial<IOpenerService>({ open: async () => true }));
			instantiationService.stub(ICommandService, upcastPartial<ICommandService>({ executeCommand: async () => undefined }));
			store.add(createParadisServiceStatusWidget(instantiationService, container));

			const buttons = [...container.querySelectorAll<HTMLButtonElement>('button.paradis-service-status-trigger')];
			const [claude, openai, github] = buttons;
			// 取得が済むと項目の aria-label が状態入りに書き換わるので、それを待つ。
			await new Promise<void>(resolve => {
				const done = () => openai.getAttribute('aria-label')?.includes('軽微') ?? false;
				if (done()) {
					resolve();
					return;
				}
				const observer = new MutationObserver(() => {
					if (done()) {
						observer.disconnect();
						resolve();
					}
				});
				observer.observe(openai, { attributes: true, attributeFilter: ['aria-label'] });
			});
			const chips = buttons.map(button => [
				button.dataset.provider,
				!!button.querySelector('.paradis-service-status-logo'),
				button.querySelector('.paradis-service-status-dot')?.className.replace('paradis-service-status-dot ', ''),
			].join(' | '));
			openai.focus();
			openai.click();
			const openedAtOpenAI = openai.classList.contains('active');
			github.click();
			const movedToGitHub = !openai.classList.contains('active') && github.classList.contains('active') && container.querySelectorAll('.paradis-service-status-popover').length === 1;
			const expandedWhileOpen = buttons.map(button => button.getAttribute('aria-expanded'));
			(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

			assert.deepStrictEqual({
				chips,
				label: openai.getAttribute('aria-label'),
				openedAtOpenAI,
				movedToGitHub,
				closed: !container.querySelector('.paradis-service-status-popover') && !github.classList.contains('active'),
				focusBack: document.activeElement === github,
				claudeLabel: claude.getAttribute('aria-label'),
				expandedWhileOpen,
				expandedAfterClose: buttons.map(button => button.getAttribute('aria-expanded')),
				popup: github.getAttribute('aria-haspopup'),
			}, {
				chips: ['claude | true | ok', 'codex | true | minor', 'github | true | ok'],
				label: 'OpenAI のステータス: 軽微な障害',
				openedAtOpenAI: true,
				movedToGitHub: true,
				closed: true,
				focusBack: true,
				claudeLabel: 'Claude のステータス: 正常',
				expandedWhileOpen: ['false', 'false', 'true'],
				expandedAfterClose: ['false', 'false', 'false'],
				popup: 'dialog',
			});
		} finally {
			container.remove();
		}
	});
});
