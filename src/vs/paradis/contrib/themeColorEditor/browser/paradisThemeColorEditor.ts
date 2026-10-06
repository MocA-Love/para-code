/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの EditorPane。上に「UI の色 / シンタックスの色」のタブ、下に未保存の件数と
// 「破棄」「保存」の帯を置き、中身は 2 つのビューに任せる。

import './media/paradisThemeColorEditor.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { PARADIS_THEME_COLORS_PICK_COMMAND_ID } from '../common/paradisThemeColorModel.js';
import { IParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';
import { ParadisThemeColorEditorInput, ParadisThemeColorRevealTarget, PARADIS_THEME_COLOR_EDITOR_ID } from './paradisThemeColorEditorInput.js';
import { ParadisSyntaxColorView } from './paradisSyntaxColorView.js';
import { ParadisUiColorView } from './paradisUiColorView.js';

const $ = dom.$;

type Tab = 'ui' | 'syntax';

export class ParadisThemeColorEditor extends EditorPane {

	static readonly ID = PARADIS_THEME_COLOR_EDITOR_ID;

	private root: HTMLElement | undefined;
	private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
	private uiView: ParadisUiColorView | undefined;
	private syntaxView: ParadisSyntaxColorView | undefined;
	private saveMessage: HTMLElement | undefined;
	private saveButton: Button | undefined;
	private discardButton: Button | undefined;
	private tab: Tab = 'ui';
	private readonly inputListener = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisThemeColorDraftService private readonly draftService: IParadisThemeColorDraftService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(PARADIS_THEME_COLOR_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const store = this._register(new DisposableStore());
		this.root = dom.append(parent, $('.paradis-tce'));

		const tabs = dom.append(this.root, $('.paradis-tce-tabs', { role: 'tablist' }));
		const tabLabels: [Tab, string][] = [
			['ui', localize('paradis.themeColors.tab.ui', "UI の色")],
			['syntax', localize('paradis.themeColors.tab.syntax', "シンタックスの色")],
		];
		for (const [tab, label] of tabLabels) {
			const button = dom.append(tabs, $<HTMLButtonElement>('button.paradis-tce-tab', { type: 'button', role: 'tab' }, label));
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.showTab(tab)));
			this.tabButtons.set(tab, button);
		}

		const body = dom.append(this.root, $('.paradis-tce-body'));
		this.uiView = store.add(this.instantiationService.createInstance(ParadisUiColorView, body, { startScreenPick: () => this.startScreenPick() }));
		this.syntaxView = store.add(this.instantiationService.createInstance(ParadisSyntaxColorView, body));

		const saveBar = dom.append(this.root, $('.paradis-tce-savebar'));
		this.saveMessage = dom.append(saveBar, $('span.paradis-tce-savebar-msg', { role: 'status' }));
		this.discardButton = store.add(new Button(saveBar, { ...defaultButtonStyles, secondary: true }));
		this.discardButton.label = localize('paradis.themeColors.discard', "破棄");
		store.add(this.discardButton.onDidClick(() => this.draftService.discard()));
		this.saveButton = store.add(new Button(saveBar, { ...defaultButtonStyles }));
		this.saveButton.label = localize('paradis.themeColors.save', "保存");
		store.add(this.saveButton.onDidClick(() => this.save()));
		store.add(this.draftService.onDidChange(() => this.renderSaveBar()));

		this.showTab(this.tab);
		this.renderSaveBar();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const store = new DisposableStore();
		this.inputListener.value = store;
		if (input instanceof ParadisThemeColorEditorInput) {
			store.add(input.onDidRequestReveal(() => this.applyReveal(input.takePendingReveal())));
			this.applyReveal(input.takePendingReveal());
		}
	}

	override clearInput(): void {
		this.inputListener.clear();
		super.clearInput();
	}

	override layout(dimension: dom.Dimension): void {
		if (this.root) {
			this.root.style.width = `${dimension.width}px`;
			this.root.style.height = `${dimension.height}px`;
		}
		this.syntaxView?.layout();
	}

	override focus(): void {
		super.focus();
		if (this.tab === 'ui') {
			this.uiView?.focus();
		} else {
			this.syntaxView?.focus();
		}
	}

	private applyReveal(target: ParadisThemeColorRevealTarget | undefined): void {
		if (!target) {
			return;
		}
		if (target.tab === 'syntax') {
			this.showTab('syntax');
			return;
		}
		this.showTab('ui');
		if (target.colorId) {
			this.uiView?.reveal(target.colorId);
		} else if (target.query !== undefined) {
			this.uiView?.setQuery(target.query);
		}
	}

	private showTab(tab: Tab): void {
		this.tab = tab;
		for (const [key, button] of this.tabButtons) {
			button.classList.toggle('on', key === tab);
			button.setAttribute('aria-selected', String(key === tab));
		}
		this.uiView?.element.classList.toggle('hidden', tab !== 'ui');
		this.syntaxView?.element.classList.toggle('hidden', tab !== 'syntax');
		if (tab === 'syntax') {
			this.syntaxView?.show();
		}
	}

	private renderSaveBar(): void {
		const count = this.draftService.dirtyCount;
		if (this.saveMessage) {
			this.saveMessage.textContent = count
				? localize('paradis.themeColors.unsaved', "未保存の変更が {0} 件あります（画面には反映済み）", count)
				: localize('paradis.themeColors.noChanges', "変更はありません。色を変えるとすぐ画面に反映され、「保存」でユーザー設定に書き込みます");
			this.saveMessage.classList.toggle('dirty', count > 0);
		}
		if (this.saveButton) {
			this.saveButton.enabled = count > 0;
		}
		if (this.discardButton) {
			this.discardButton.enabled = count > 0;
		}
	}

	private async save(): Promise<void> {
		try {
			await this.draftService.save();
		} catch (error) {
			this.notificationService.error(localize('paradis.themeColors.saveFailed', "テーマの色を保存できませんでした: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private startScreenPick(): void {
		this.commandService.executeCommand(PARADIS_THEME_COLORS_PICK_COMMAND_ID);
	}
}
