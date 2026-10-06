/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget, IConfigurationValue } from '../../../../../platform/configuration/common/configuration.js';
import { IConfirmation, IConfirmationResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { ParadisThemeColorDraftService } from '../../browser/paradisThemeColorDraftService.js';

const COLORS = 'workbench.colorCustomizations';
const TOKENS = 'editor.tokenColorCustomizations';

interface ILayers {
	default?: unknown;
	user?: unknown;
	workspace?: unknown;
	memory?: unknown;
}

/** 層（default / user / workspace / memory）を持つ設定サービス。USER への書き込みは gate が開くまで待たせられる。 */
class LayeredConfigurationService extends TestConfigurationService {

	readonly layers = new Map<string, ILayers>();
	readonly writes: { key: string; target: ConfigurationTarget | undefined }[] = [];
	userWriteGate: Promise<void> | undefined;

	layer(key: string): ILayers {
		let layer = this.layers.get(key);
		if (!layer) {
			layer = {};
			this.layers.set(key, layer);
		}
		return layer;
	}

	override inspect<T>(key: string): IConfigurationValue<T> {
		const layer = this.layer(key);
		return {
			defaultValue: layer.default as T,
			userValue: layer.user as T,
			userLocalValue: layer.user as T,
			workspaceValue: layer.workspace as T,
			memoryValue: layer.memory as T,
		};
	}

	override async updateValue(key: string, value: unknown, arg3?: unknown): Promise<void> {
		// 3 番目の引数は ConfigurationTarget（数値）か overrides。ここでは target の形しか使わない。
		const target = typeof arg3 === 'number' ? arg3 as ConfigurationTarget : undefined;
		this.writes.push({ key, target });
		if (target === ConfigurationTarget.MEMORY) {
			this.layer(key).memory = value;
			this.fire(key, ConfigurationTarget.MEMORY);
			return;
		}
		await this.userWriteGate;
		this.layer(key).user = value;
		this.fire(key, ConfigurationTarget.USER);
	}

	/** settings.json の手編集や別のウィンドウでの変更を真似る。 */
	changeUserOutside(key: string, value: unknown): void {
		this.layer(key).user = value;
		this.fire(key, ConfigurationTarget.USER);
	}

	private fire(key: string, source: ConfigurationTarget): void {
		this.onDidChangeConfigurationEmitter.fire({
			source,
			affectedKeys: new Set([key]),
			change: { keys: [key], overrides: [] },
			affectsConfiguration: (configuration: string) => configuration === key,
		});
	}
}

/** 確認ダイアログを出している間に何かが起きる（ほかの所で設定が変わる）ダイアログ。 */
class InterruptingDialogService extends TestDialogService {
	readonly asked: IConfirmation[] = [];
	constructor(private readonly whileOpen: () => void) {
		super();
	}
	override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		this.asked.push(confirmation);
		this.whileOpen();
		return { confirmed: true };
	}
}

suite('ParadisThemeColorDraftService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(confirmed = true): { configuration: LayeredConfigurationService; service: ParadisThemeColorDraftService; disposables: DisposableStore } {
		const disposables = store.add(new DisposableStore());
		const configuration = new LayeredConfigurationService();
		disposables.add({ dispose: () => configuration.onDidChangeConfigurationEmitter.dispose() });
		configuration.layer(COLORS).default = { '[Houston]': { 'statusBar.background': '#09AFD9' } };
		configuration.layer(COLORS).user = { 'editor.foreground': '#EEEEEE', '[Houston]': { 'editor.background': '#111111' } };
		configuration.layer(COLORS).memory = { 'focusBorder': '#ABCDEF' };
		const service = disposables.add(new ParadisThemeColorDraftService(configuration, new TestThemeService(), new TestDialogService({ confirmed })));
		return { configuration, service, disposables };
	}

	test('editing then discarding restores the memory layer', () => {
		const { configuration, service } = create();
		service.setColor('Houston', 'statusBar.background', '#FF0000');
		const during = { memory: configuration.layer(COLORS).memory, dirty: service.dirtyCount };
		service.discard();
		assert.deepStrictEqual({ during, after: { memory: configuration.layer(COLORS).memory, dirty: service.dirtyCount, user: configuration.layer(COLORS).user } }, {
			during: { memory: { 'focusBorder': '#ABCDEF', '[Houston]': { 'statusBar.background': '#FF0000' } }, dirty: 1 },
			after: { memory: { 'focusBorder': '#ABCDEF' }, dirty: 0, user: { 'editor.foreground': '#EEEEEE', '[Houston]': { 'editor.background': '#111111' } } },
		});
	});

	test('saving writes to USER and restores the memory layer', async () => {
		const { configuration, service } = create();
		service.setColor('Houston', 'statusBar.background', '#FF0000');
		service.setColor('Houston', 'editor.background', undefined);
		const saved = await service.save();
		assert.deepStrictEqual({
			saved,
			user: configuration.layer(COLORS).user,
			memory: configuration.layer(COLORS).memory,
			dirty: service.dirtyCount,
			userWrites: configuration.writes.filter(write => write.target === ConfigurationTarget.USER).map(write => write.key),
		}, {
			saved: true,
			user: { 'editor.foreground': '#EEEEEE', '[Houston]': { 'statusBar.background': '#FF0000' } },
			memory: { 'focusBorder': '#ABCDEF' },
			dirty: 0,
			userWrites: [COLORS],
		});
	});

	test('changes made elsewhere while editing survive the save', async () => {
		const { configuration, service } = create();
		configuration.layer(TOKENS).user = { '[Houston]': { comments: '#00FF00' } };
		service.setColor('Houston', 'statusBar.background', '#FF0000');
		service.setScopedDraft('token', 'Houston', { ...service.getScopedDraft('token', 'Houston'), keywords: '#FF0000' });

		configuration.changeUserOutside(COLORS, { 'editor.foreground': '#EEEEEE', '[Houston]': { 'editor.background': '#111111', 'tab.activeBorderTop': '#222222' } });
		configuration.changeUserOutside(TOKENS, { '[Houston]': { comments: '#0000FF', strings: '#123456' } });
		await service.save();
		assert.deepStrictEqual({ colors: configuration.layer(COLORS).user, tokens: configuration.layer(TOKENS).user, dirty: service.dirtyCount }, {
			colors: { 'editor.foreground': '#EEEEEE', '[Houston]': { 'editor.background': '#111111', 'tab.activeBorderTop': '#222222', 'statusBar.background': '#FF0000' } },
			tokens: { '[Houston]': { comments: '#0000FF', strings: '#123456', keywords: '#FF0000' } },
			dirty: 0,
		});
	});

	test('textMateRules changed elsewhere ask before overwriting; declining writes nothing', async () => {
		const { configuration, service } = create(false);
		configuration.layer(TOKENS).user = { '[Houston]': { textMateRules: [{ scope: 'a', settings: { foreground: '#111111' } }] } };
		const draft = service.getScopedDraft('token', 'Houston');
		service.setScopedDraft('token', 'Houston', { textMateRules: [...(draft.textMateRules as unknown[]), { scope: 'b', settings: { foreground: '#222222' } }] });
		configuration.changeUserOutside(TOKENS, { '[Houston]': { textMateRules: [{ scope: 'c', settings: {} }] } });
		const saved = await service.save();
		assert.deepStrictEqual({ saved, tokens: configuration.layer(TOKENS).user, dirty: service.dirtyCount }, {
			saved: false,
			tokens: { '[Houston]': { textMateRules: [{ scope: 'c', settings: {} }] } },
			dirty: 1,
		});
		service.discard();
	});

	test('edits made while saving are kept as drafts', async () => {
		const { configuration, service } = create();
		const gate = new DeferredPromise<void>();
		configuration.userWriteGate = gate.p;
		service.setColor('Houston', 'statusBar.background', '#FF0000');
		service.setColor('Houston', 'tab.activeBorderTop', '#333333');
		const saving = service.save();
		// 書き込みを待っている間に、同じ色を変え直し、別の色も変える
		service.setColor('Houston', 'statusBar.background', '#00FF00');
		service.setColor('Houston', 'badge.background', '#444444');
		gate.complete();
		await saving;
		assert.deepStrictEqual({
			user: configuration.layer(COLORS).user,
			drafts: service.getColorEditIds('Houston').map(id => [id, service.getColorEdit('Houston', id)?.save]),
			memory: configuration.layer(COLORS).memory,
		}, {
			user: { 'editor.foreground': '#EEEEEE', '[Houston]': { 'editor.background': '#111111', 'statusBar.background': '#FF0000', 'tab.activeBorderTop': '#333333' } },
			drafts: [['statusBar.background', '#00FF00'], ['badge.background', '#444444']],
			memory: { 'focusBorder': '#ABCDEF', '[Houston]': { 'statusBar.background': '#00FF00', 'badge.background': '#444444' } },
		});
		service.discard();
	});

	test('changes made elsewhere while the confirm dialog is open survive the save', async () => {
		const disposables = store.add(new DisposableStore());
		const configuration = new LayeredConfigurationService();
		disposables.add({ dispose: () => configuration.onDidChangeConfigurationEmitter.dispose() });
		configuration.layer(COLORS).user = { '[Houston]': { 'editor.background': '#111111' } };
		configuration.layer(TOKENS).user = { '[Houston]': { textMateRules: [{ scope: 'a', settings: {} }] } };
		const dialog = new InterruptingDialogService(() => {
			configuration.changeUserOutside(COLORS, { '[Houston]': { 'editor.background': '#111111', 'tab.activeBorderTop': '#222222' } });
			configuration.changeUserOutside(TOKENS, { '[Houston]': { comments: '#0000FF', textMateRules: [{ scope: 'c', settings: {} }] } });
		});
		const service = disposables.add(new ParadisThemeColorDraftService(configuration, new TestThemeService(), dialog));
		service.setColor('Houston', 'statusBar.background', '#FF0000');
		service.setScopedDraft('token', 'Houston', { textMateRules: [{ scope: 'a', settings: {} }, { scope: 'b', settings: {} }] });
		configuration.changeUserOutside(TOKENS, { '[Houston]': { textMateRules: [{ scope: 'c', settings: {} }] } });
		const saved = await service.save();
		assert.deepStrictEqual({ saved, asked: dialog.asked.length, colors: configuration.layer(COLORS).user, tokens: configuration.layer(TOKENS).user }, {
			saved: true,
			asked: 1,
			colors: { '[Houston]': { 'editor.background': '#111111', 'tab.activeBorderTop': '#222222', 'statusBar.background': '#FF0000' } },
			tokens: { '[Houston]': { comments: '#0000FF', textMateRules: [{ scope: 'a', settings: {} }, { scope: 'b', settings: {} }] } },
		});
	});
});
