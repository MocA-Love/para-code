/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アドレスバーの中に、今のページの大きさを出しっぱなしにする chip（Q451）。
//
// upstream のファイルには触らず、公開されている拡張点だけで足している:
//  - `BrowserEditor.registerContribution()` で contribution を登録し、`BrowserWidgetLocation.PostUrl` に出す
//  - 大きさは upstream の Device Emulation（`IBrowserViewModel.setDevice`）で当てる
//
// upstream の Device Emulation の帯（幅・高さ・DPR・倍率・UA の入力欄）は、device を立てた瞬間に出る。chip で
// 選ぶたびに帯が出ると、同じ大きさが二重に見えるので、CSS で隠しておき、一覧の「細かい設定の帯を表示」か
// upstream のコマンド「Device Emulation」を実行したときだけ出す（media/paradisBrowserViewport.css）。
// 帯を隠しても、端の大きさを変えるつまみ（sash）とその分の右と下の余白は upstream のまま残る。

import * as dom from '../../../../base/browser/dom.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisViewportSize,
	IParadisViewportState,
	ParadisViewportTarget,
	paradisFindViewportSize,
	paradisFormatViewportDimensions,
	paradisResolveViewportSpec,
	paradisSanitizeViewportName,
	paradisViewportSpecMatches,
} from '../common/paradisBrowserViewport.js';
import { IParadisViewportDefaultMarks, ParadisBrowserViewportDropdown } from './paradisBrowserViewportDropdown.js';
import { paradisShowViewportManager } from './paradisBrowserViewportManager.js';
import { IParadisBrowserViewportService } from './paradisBrowserViewportService.js';

const $ = dom.$;

/**
 * URL ボックス内での並び順。共有トグル (50)・ブックマークの星 (60) → プロファイル (70) → 大きさ (80) →
 * 倍率 (90) → タブ pill (100)（ユーザーの指示: お気に入りなどはプロファイルの左）。
 */
const WIDGET_ORDER = 80;

/** エージェントが変えた直後に chip を強調する時間。 */
const AGENT_HIGHLIGHT_MS = 4000;

/** upstream の帯を出しているときに `.browser-root` へ付けるクラス。 */
const BAND_SHOWN_CLASS = 'paradis-viewport-band-shown';

/** upstream の Device Emulation の帯を開け閉めするコマンド（browserEditorEmulationFeatures.ts）。 */
const TOGGLE_DEVICE_EMULATION_COMMAND = 'workbench.action.browser.toggleDeviceEmulation';

export class ParadisBrowserViewportChip extends BrowserEditorContribution {

	private readonly _element: HTMLButtonElement;
	private readonly _nameElement: HTMLElement;
	private readonly _dimensionsElement: HTMLElement;
	private readonly _hover: IManagedHover;
	private readonly _dropdown = this._register(new MutableDisposable<ParadisBrowserViewportDropdown>());
	private readonly _highlight = this._register(new MutableDisposable());
	private _bandShown = false;

	constructor(
		editor: BrowserEditor,
		@IParadisBrowserViewportService private readonly viewportService: IParadisBrowserViewportService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService commandService: ICommandService,
		@IHoverService hoverService: IHoverService,
	) {
		super(editor);

		this._element = $('button.paradis-browser-viewport-chip');
		this._element.setAttribute('aria-haspopup', 'listbox');
		this._element.setAttribute('aria-expanded', 'false');
		this._nameElement = dom.append(this._element, $('span.pbv-chip-name'));
		this._dimensionsElement = dom.append(this._element, $('span.pbv-chip-dimensions'));
		dom.append(this._element, $(`span.pbv-chip-chevron${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		this._hover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this._element, ''));
		this._register(dom.addDisposableListener(this._element, dom.EventType.CLICK, () => this._toggleDropdown()));

		this._register(this.viewportService.onDidChange(() => this._render()));
		this._register(this.viewportService.onDidAgentChange(viewId => {
			if (this.editor.model?.id === viewId) {
				this._flashAgentChange();
				this._render();
			}
		}));
		// upstream のコマンド「Device Emulation」で帯を開いたときは、隠さずに見せる
		this._register(commandService.onDidExecuteCommand(event => {
			if (event.commandId !== TOGGLE_DEVICE_EMULATION_COMMAND || !this.editor.model?.device) {
				return;
			}
			if (event.args[0] === this.editor || this.editorService.activeEditorPane === this.editor) {
				this._setBandShown(true);
			}
		}));

		this._render();
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.PostUrl, element: this._element, order: WIDGET_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore, isNew: boolean): void {
		this._dropdown.clear();
		this._highlight.clear();
		store.add(model.onDidChangeDevice(device => {
			if (!device) {
				this._setBandShown(false);
			}
			this._render();
		}));
		store.add(model.onDidChangeZoom(() => this._measure()));
		// 既定は新しく開いたタブにだけ当てる（paradisBrowserViewportService.ts の claimDefaultApplication）
		const claimed = this.viewportService.claimDefaultApplication(model.id);
		if (isNew && claimed && !model.device) {
			this._applyDefault(model);
		}
		this._render();
	}

	override onModelDetached(): void {
		this._dropdown.clear();
		this._highlight.clear();
		this._render();
	}

	override afterContainerLayout(): void {
		this._measure();
	}

	// #region 大きさ

	/** エディタに合わせたときのページの大きさを測って覚える。大きさを決めている間は測らない（余白の分ずれる）。 */
	private _measure(): void {
		const model = this.editor.model;
		if (!model || model.device?.width || model.device?.height) {
			return;
		}
		const pane = this.editor.paneSize;
		if (pane.width <= 0 || pane.height <= 0) {
			return;
		}
		// ページの CSS px = workbench の CSS px × ウィンドウの倍率 ÷ ページの倍率
		const scale = getZoomFactor(dom.getWindow(this._element)) / (model.zoomFactor || 1);
		const size = { width: Math.round(pane.width * scale), height: Math.round(pane.height * scale) };
		const before = this.viewportService.getPaneSize(model.id);
		if (before?.width !== size.width || before?.height !== size.height) {
			this.viewportService.notePaneSize(model.id, size);
			this._render();
		}
	}

	private _applyDefault(model: IBrowserViewModel): void {
		const { spec } = this.viewportService.resolveDefaultForView(model.id);
		const target = paradisResolveViewportSpec(spec, this.viewportService.getSizes());
		if (target?.kind === 'size') {
			this._run(this.viewportService.apply(model, target, { kind: 'default' }));
		}
	}

	private _applyUser(target: ParadisViewportTarget): void {
		const model = this.editor.model;
		if (model) {
			this._run(this.viewportService.apply(model, target, { kind: 'user' }));
		}
	}

	private _run(promise: Promise<unknown>): void {
		promise.catch(error => {
			reportParadisDiagnosticError('owned', 'browser-viewport', 'apply-failed', error);
			onUnexpectedError(error);
		});
	}

	private _currentTarget(state: IParadisViewportState): ParadisViewportTarget {
		if (state.fit) {
			return { kind: 'fit' };
		}
		const named = state.name !== undefined ? paradisFindViewportSize(this.viewportService.getSizes(), state.name) : undefined;
		return named ? { kind: 'size', size: named } : { kind: 'size', size: { width: state.width ?? 0, height: state.height ?? 0 } };
	}

	/** 既定に書く指定。エディタに合わせるは空文字、名前付きは名前、それ以外は「幅x高さ」。 */
	private _specOf(target: ParadisViewportTarget): string {
		if (target.kind === 'fit') {
			return '';
		}
		return target.size.name ?? `${target.size.width}x${target.size.height}`;
	}

	private _marksFor(target: ParadisViewportTarget): IParadisViewportDefaultMarks {
		const sizes = this.viewportService.getSizes();
		const model = this.editor.model;
		const stateKey = model ? this.viewportService.getSpaceOfView(model.id) : undefined;
		const own = stateKey !== undefined ? this.viewportService.getSpaceDefault(stateKey) : undefined;
		const resolved = model ? this.viewportService.resolveDefaultForView(model.id) : undefined;
		return {
			global: paradisViewportSpecMatches(this.viewportService.getGlobalDefault(), target, sizes),
			space: own !== undefined && paradisViewportSpecMatches(own, target, sizes),
			parentSpace: own === undefined && resolved?.source === 'parentSpace' && paradisViewportSpecMatches(resolved.spec, target, sizes),
		};
	}

	// #endregion

	// #region 描画

	private _render(): void {
		const model = this.editor.model;
		this._element.classList.toggle('is-detached', model === undefined);
		if (!model) {
			return;
		}
		const state = this.viewportService.describe(model);
		const dimensions = paradisFormatViewportDimensions(state.width, state.height);
		const name = state.fit ? localize('paradis.browserViewport.chip.auto', "自動") : state.name;
		this._nameElement.textContent = name ?? '';
		this._nameElement.style.display = name ? '' : 'none';
		this._dimensionsElement.textContent = dimensions;
		this._element.classList.toggle('is-fit', state.fit);

		const lines: string[] = [state.fit
			? localize('paradis.browserViewport.chip.hoverFit', "ページの大きさ: エディタに合わせる（{0}）", dimensions)
			: name
				? localize('paradis.browserViewport.chip.hoverNamed', "ページの大きさ: {0}（{1}）", name, dimensions)
				: localize('paradis.browserViewport.chip.hoverCustom', "ページの大きさ: {0}", dimensions)];
		if (state.mobile) {
			lines.push(localize('paradis.browserViewport.chip.hoverMobile', "タッチ操作とスマホの見た目も当てています。"));
		}
		const agentChange = this.viewportService.getAgentChange(model.id);
		if (agentChange) {
			lines.push(localize(
				'paradis.browserViewport.chip.hoverAgent',
				"エージェント（{0}）が {1} から {2} に変更しました（{3}）。",
				agentChange.agentLabel,
				this._stateLabel(agentChange.previous),
				this._stateLabel(agentChange.next),
				fromNow(agentChange.at, true),
			));
		}
		lines.push(localize('paradis.browserViewport.chip.hoverAction', "押すと大きさを選べます。"));
		this._hover.update(lines.join('\n'));
		this._element.setAttribute('aria-label', lines.join(' '));
	}

	private _stateLabel(state: IParadisViewportState): string {
		const dimensions = paradisFormatViewportDimensions(state.width, state.height);
		if (state.fit) {
			return localize('paradis.browserViewport.chip.labelAuto', "自動 {0}", dimensions);
		}
		return state.name ? `${state.name} ${dimensions}` : dimensions;
	}

	private _flashAgentChange(): void {
		this._element.classList.add('is-agent-changed');
		const handle = setTimeout(() => this._element.classList.remove('is-agent-changed'), AGENT_HIGHLIGHT_MS);
		this._highlight.value = toDisposable(() => {
			clearTimeout(handle);
			this._element.classList.remove('is-agent-changed');
		});
	}

	private _setBandShown(shown: boolean): void {
		if (this._bandShown === shown) {
			return;
		}
		this._bandShown = shown;
		this._element.closest('.browser-root')?.classList.toggle(BAND_SHOWN_CLASS, shown);
		this.editor.layoutBrowserContainer();
	}

	// #endregion

	// #region 一覧

	private _toggleDropdown(): void {
		if (this._dropdown.value) {
			this._dropdown.clear();
			return;
		}
		const model = this.editor.model;
		if (!model) {
			return;
		}
		const state = this.viewportService.describe(model);
		const current = this._currentTarget(state);
		const stateKey = this.viewportService.getSpaceOfView(model.id);
		const close = (action: () => void) => () => {
			this._dropdown.clear();
			action();
		};
		this._dropdown.value = this.instantiationService.createInstance(ParadisBrowserViewportDropdown, {
			anchor: this._element,
			current: state,
			sizes: this.viewportService.getSizes(),
			fitSize: this.viewportService.getPaneSize(model.id),
			marksFor: target => this._marksFor(target),
			currentMarks: this._marksFor(current),
			spaceLabel: stateKey !== undefined ? this.viewportService.getSpaceLabel(stateKey) : undefined,
			bandVisible: model.device ? this._bandShown : undefined,
			onSelectSize: size => close(() => this._applyUser({ kind: 'size', size }))(),
			onSelectFit: close(() => this._applyUser({ kind: 'fit' })),
			onApplyDimensions: (width, height) => close(() => this._applyUser({ kind: 'size', size: { width, height } }))(),
			onSaveCurrent: close(() => void this._saveCurrent(state)),
			onSetGlobalDefault: close(() => {
				const marks = this._marksFor(current);
				this._run(this.viewportService.setGlobalDefault(marks.global ? '' : this._specOf(current)));
			}),
			onToggleSpaceDefault: close(() => {
				if (stateKey !== undefined) {
					this.viewportService.setSpaceDefault(stateKey, this._marksFor(current).space ? undefined : this._specOf(current));
				}
			}),
			onToggleBand: close(() => this._setBandShown(!this._bandShown)),
			onManage: close(() => this._run(this.instantiationService.invokeFunction(paradisShowViewportManager))),
		});
	}

	private async _saveCurrent(state: IParadisViewportState): Promise<void> {
		const model = this.editor.model;
		if (!model || !state.width || !state.height) {
			return;
		}
		const name = await this.quickInputService.input({
			prompt: localize('paradis.browserViewport.save.prompt', "{0} に付ける名前（同じ名前があれば置き換えます）", paradisFormatViewportDimensions(state.width, state.height)),
			value: state.name ?? '',
			validateInput: async value => paradisSanitizeViewportName(value) ? undefined : localize('paradis.browserViewport.save.invalid', "1〜40 文字で、「1366x768」の形ではない名前にしてください。"),
		});
		const cleaned = name !== undefined ? paradisSanitizeViewportName(name) : undefined;
		if (!cleaned) {
			return;
		}
		const device = model.device;
		const size: IParadisViewportSize = {
			name: cleaned,
			width: state.width,
			height: state.height,
			...(device?.mobile ? { mobile: true } : {}),
			...(device?.deviceScaleFactor ? { deviceScaleFactor: device.deviceScaleFactor } : {}),
			...(device?.userAgent ? { userAgent: device.userAgent } : {}),
		};
		if (!this.viewportService.saveSize(size)) {
			this.notificationService.warn(localize('paradis.browserViewport.save.limit', "保存できる大きさの数の上限に達しています。「大きさの管理…」で使わないものを消してください。"));
			return;
		}
		// 保存した大きさを、このタブにもそのまま当てる（名前で chip に出るように）
		this._applyUser({ kind: 'size', size });
	}

	// #endregion
}

BrowserEditor.registerContribution(ParadisBrowserViewportChip);
