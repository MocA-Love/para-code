/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのタブに、エージェントが置いたスクリプト（add_init_script）が入っている間、アドレスバーに
// 本数の印を出す（Q537 の 7 章、案 B。以前はナビバーの下の帯だった）。スクリプトはページを読み込むたびに動き、利用者がそのタブで見るページにも効くので、入っていることと
// 「誰が・何を」入れたかが見えるようにする（q.html の Q300、案 C）。
//
//  - 印: 本数。ホバーで説明、押すと一覧
//  - 一覧: 名前・持ち主（名札・ペイン番号）・時刻・大きさ。1 本ずつ外せ、「中身を見る」で全文を読み取り専用の
//    エディタに開く
//
// 一覧と本文は electron-main から PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL で取る（タブ＝BrowserView の id ごと）。
// 一覧はブラウザのページに重なるので、内蔵ブラウザが前面の DOM を検知して一時的に退く `context-view`
// （IContextViewService）で出す。upstream のファイルには触らず、BrowserEditor.registerContribution() の拡張点だけで足している。

import './media/paradisAgentPageScriptsBanner.css';
import { $, addDisposableListener, append, EventType, isAncestor, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { status as ariaStatus } from '../../../../base/browser/ui/aria/aria.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisAgentPageScriptEntry, IParadisAgentPageScriptOwner, IParadisAgentPageScriptsSurface, paradisAgentPageScriptUri, paradisPaneFingerprint, paradisParseAgentPageScriptUri, PARADIS_AGENT_PAGE_SCRIPT_SCHEME, PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { paradisRefreshAgentPageScriptModels } from '../browser/paradisAgentPageScriptModels.js';

/** アドレスバーの右の印の並び順（星 60 の後、プロファイル 70 の前）。 */
const CHIP_ORDER = 65;

/** 置いた時刻（時:分:秒）。 */
function timeOf(addedAt: number): string {
	const date = new Date(addedAt);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** 持ち主の名札とペイン番号（一覧の 2 行目に出す）。 */
function ownerText(owner: IParadisAgentPageScriptOwner | undefined, paneOf: (fingerprint: string) => number | undefined): string | undefined {
	if (!owner) {
		return undefined;
	}
	const pane = paneOf(owner.pane);
	return pane === undefined
		? owner.name
		: localize('paradis.agentPageScripts.ownerWithPane', "{0} · ペイン {1}", owner.name, pane);
}

/** スクリプトの名前。名前が無いもの（本文の先頭 40 字）は等幅で出し、「名前なし」を添える。 */
function appendScriptName(parent: HTMLElement, entry: IParadisAgentPageScriptEntry, className: string): void {
	const name = append(parent, $(`span.${className}`));
	name.textContent = entry.label;
	if (!entry.named) {
		name.classList.add('paradis-page-scripts-unnamed');
		append(parent, $('span.paradis-page-scripts-tag')).textContent = localize('paradis.agentPageScripts.unnamed', "名前なし");
	}
}

/**
 * タブにエージェントのスクリプトが入っている間だけ、アドレスバーに出す印（本数）。押すと一覧を開く。
 * 帯をやめてページの領域を動かさない形にした（Q537 の 7 章「ページのスクリプトの帯」、案 B）。
 */
export class ParadisAgentPageScriptsBanner extends BrowserEditorContribution {

	private readonly surface: IParadisAgentPageScriptsSurface;
	private readonly chip: HTMLButtonElement;
	private readonly count: HTMLElement;
	private readonly details = this._register(new MutableDisposable<IDisposable>());
	private entries: readonly IParadisAgentPageScriptEntry[] = [];
	/** 一覧を取り直す世代（古い応答で新しい表示を上書きしない）。 */
	private refreshGeneration = 0;
	/** 一覧を 1 回でも取れたタブ（2 回目からは増えた分を読み上げる）。 */
	private loadedModel: IBrowserViewModel | undefined;

	constructor(
		editor: BrowserEditor,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IHoverService private readonly hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(editor);
		this.surface = ProxyChannel.toService<IParadisAgentPageScriptsSurface>(mainProcessService.getChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL));
		this.chip = $<HTMLButtonElement>('button.paradis-page-scripts-chip.paradis-focus-ring-inset');
		this.chip.type = 'button';
		this.chip.style.display = 'none';
		this.chip.setAttribute('aria-haspopup', 'dialog');
		append(this.chip, $(`span${ThemeIcon.asCSSSelector(Codicon.code)}`));
		this.count = append(this.chip, $('span.paradis-page-scripts-chip-count'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.chip, () => this.chipLabel()));
		this._register(addDisposableListener(this.chip, EventType.CLICK, () => this.toggleDetails()));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.PostUrl, element: this.chip, order: CHIP_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(this.surface.onDidChangeInitScripts(change => {
			if (change.viewId === model.id) {
				void this.refresh(model);
			}
		}));
		// エージェントと共有中のタブで、ブラウザ拡張のページへの移動を止めたことを知らせる
		store.add(this.surface.onDidBlockExtensionNavigation(viewId => {
			if (viewId === model.id) {
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('paradis.agentBrowser.extensionPageBlocked', "エージェントと共有中のタブでは拡張機能のページを開けません。共有を外すと開けます。"),
				});
			}
		}));
		this.render([]);
		void this.refresh(model);
	}

	override onModelDetached(): void {
		this.refreshGeneration++;
		this.loadedModel = undefined;
		this.details.clear();
		this.render([]);
	}

	/** 一覧を取り直して印（と開いていれば一覧）を描き直す。 */
	private async refresh(model: IBrowserViewModel): Promise<void> {
		const generation = ++this.refreshGeneration;
		let entries: IParadisAgentPageScriptEntry[];
		try {
			entries = await this.surface.listInitScripts(model.id);
		} catch (error) {
			this.logService.warn('[ParadisAgentPageScripts] could not read the scripts of the tab', error);
			return;
		}
		if (generation !== this.refreshGeneration || this.editor.model !== model) {
			return;
		}
		// タブを開いた直後の 1 回目は読み上げない（入っている分を「入れた」と言わない）
		this.render(entries, this.loadedModel === model);
		this.loadedModel = model;
	}

	/** ペインの指紋 → ターミナルの番号（このウィンドウのペインだけ。ほかのウィンドウのものは分からない）。 */
	private paneNumbers(): (fingerprint: string) => number | undefined {
		const byFingerprint = new Map<string, number>();
		for (const { instanceId, token } of this.paneTokenService.listPaneTokens()) {
			byFingerprint.set(paradisPaneFingerprint(token), instanceId);
		}
		return fingerprint => byFingerprint.get(fingerprint);
	}

	/** いちばん新しい 1 本の名前と持ち主（印の説明と読み上げに使う）。 */
	private latestText(): string | undefined {
		const latest = this.entries[this.entries.length - 1];
		if (!latest) {
			return undefined;
		}
		const owner = ownerText(latest.owner, this.paneNumbers());
		return owner === undefined ? latest.label : localize('paradis.agentPageScripts.latest', "{0}（{1}）", latest.label, owner);
	}

	private chipLabel(): string {
		return localize('paradis.agentPageScripts.chipTitle', "このタブにエージェントのスクリプトが入っています（{0} 本、いちばん新しいもの: {1}）。ページを読み込むたびに動きます。", this.entries.length, this.latestText() ?? '');
	}

	private async removeAll(button?: Button): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		// 外している間は押せなくし、終わったら戻す（一覧が描き直されて消えていても害はない）
		if (button) {
			button.enabled = false;
		}
		try {
			await this.surface.removeAllInitScripts(model.id);
		} catch (error) {
			this.logService.warn('[ParadisAgentPageScripts] could not remove the scripts of the tab', error);
		} finally {
			if (button) {
				button.enabled = true;
			}
		}
	}

	private async removeOne(id: string): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		try {
			await this.surface.removeInitScript(model.id, id);
		} catch (error) {
			this.logService.warn('[ParadisAgentPageScripts] could not remove a script of the tab', error);
		}
	}

	private openSource(entry: IParadisAgentPageScriptEntry): void {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		this.details.clear();
		void this.editorService.openEditor({
			resource: paradisAgentPageScriptUri(model.id, entry.id),
			label: `${entry.id} ${entry.label}`,
			options: { pinned: true },
		});
	}

	private render(entries: readonly IParadisAgentPageScriptEntry[], announce = false): void {
		const added = announce && entries.length > this.entries.length;
		this.entries = entries;
		if (added) {
			// 帯（role=status）の代わりに、増えたときだけ 1 回読み上げる
			const latest = entries[entries.length - 1];
			const owner = latest.owner?.name;
			ariaStatus(owner === undefined
				? localize('paradis.agentPageScripts.addedAnnounce', "エージェントがスクリプト「{0}」を入れました", latest.label)
				: localize('paradis.agentPageScripts.addedAnnounceOwner', "{0} がスクリプト「{1}」を入れました", owner, latest.label));
		}
		this.count.textContent = String(entries.length);
		this.chip.setAttribute('aria-label', this.chipLabel());
		const visible = entries.length > 0;
		if (!visible) {
			this.details.clear();
		} else if (this.details.value) {
			// 開いている一覧も描き直す
			this.showDetails();
		}
		this.chip.style.display = visible ? '' : 'none';
	}

	private toggleDetails(): void {
		if (this.details.value) {
			this.details.clear();
		} else {
			this.showDetails();
		}
	}

	/** 一行のアイコンのボタン（ホバーで説明）。 */
	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, store: DisposableStore, run: (() => void) | undefined): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>(`button.paradis-page-scripts-icon-button.paradis-focus-ring-inset${ThemeIcon.asCSSSelector(icon)}`));
		button.type = 'button';
		button.setAttribute('aria-label', label);
		store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, label));
		if (run) {
			store.add(addDisposableListener(button, EventType.CLICK, run));
		} else {
			button.disabled = true;
		}
		return button;
	}

	/** 一覧を出す（新しい順）。ブラウザのページに重なるので context view で出す。 */
	private showDetails(): void {
		const entries = this.entries;
		const paneOf = this.paneNumbers();
		this.chip.classList.add('active');
		/** 自分で閉じている最中（`handle` の dispose の中）か。 */
		let closing = false;
		const view = this.contextViewService.showContextView({
			getAnchor: () => this.chip,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			render: container => {
				const store = new DisposableStore();
				const popover = append(container, $('.paradis-page-scripts-details'));
				popover.setAttribute('role', 'dialog');
				popover.setAttribute('aria-label', localize('paradis.agentPageScripts.detailsLabel', "このタブのエージェントのスクリプト"));
				const header = append(popover, $('.paradis-page-scripts-details-header'));
				append(header, $('span.paradis-page-scripts-details-title')).textContent = localize('paradis.agentPageScripts.detailsHeader', "このタブのエージェントのスクリプト（{0} 本）・新しい順", entries.length);
				const removeAll = store.add(new Button(header, { ...defaultButtonStyles, secondary: true }));
				removeAll.element.classList.add('paradis-page-scripts-small-button');
				removeAll.label = localize('paradis.agentPageScripts.removeAll', "すべて外す");
				store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), removeAll.element, localize('paradis.agentPageScripts.removeTitle', "このタブからエージェントのスクリプトをすべて外します。読み込み済みのページは、再読み込みするまでスクリプトの効果が残ります。")));
				store.add(removeAll.onDidClick(() => void this.removeAll(removeAll)));
				this.iconButton(header, Codicon.close, localize('paradis.agentPageScripts.close', "閉じる"), store, () => this.details.clear());

				const list = append(popover, $('.paradis-page-scripts-details-list'));
				for (const entry of [...entries].reverse()) {
					const row = append(list, $('.paradis-page-scripts-details-row'));
					append(row, $(`span.paradis-page-scripts-row-icon${ThemeIcon.asCSSSelector(Codicon.code)}`));
					const main = append(row, $('.paradis-page-scripts-details-main'));
					const first = append(main, $('.paradis-page-scripts-details-name'));
					appendScriptName(first, entry, 'paradis-page-scripts-details-label');
					const meta = localize(
						'paradis.agentPageScripts.meta', "{0} · {1} に入れた · {2} 字 · {3} 行",
						entry.id, timeOf(entry.addedAt), entry.chars.toLocaleString(), entry.lines.toLocaleString());
					const owner = ownerText(entry.owner, paneOf);
					append(main, $('.paradis-page-scripts-details-meta')).textContent = owner === undefined
						? meta
						: localize('paradis.agentPageScripts.ownerAndMeta', "{0} · {1}", owner, meta);
					this.iconButton(row, Codicon.goToFile, entry.sourceKept
						? localize('paradis.agentPageScripts.view', "中身を見る")
						: localize('paradis.agentPageScripts.sourceNotKept', "スクリプトが多いため、この本文は保持していません。"), store, entry.sourceKept ? () => this.openSource(entry) : undefined);
					this.iconButton(row, Codicon.close, localize('paradis.agentPageScripts.remove', "外す"), store, () => void this.removeOne(entry.id));
				}
				append(popover, $('.paradis-page-scripts-details-footer')).textContent = localize('paradis.agentPageScripts.detailsFooter', "外しても、読み込み済みのページは再読み込みするまで効果が残ります。");
				store.add(addDisposableListener(popover, EventType.KEY_DOWN, event => {
					if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
						event.preventDefault();
						this.details.clear();
						this.chip.focus();
					}
				}));
				return store;
			},
			onDOMEvent: (event: { readonly target?: EventTarget | null }) => {
				// 既定では「ワークベンチの外」でしか閉じないので、一覧と印の外を押したら閉じる。
				// ここへ来るイベントは包まれていて `type` を持たないので、見るのは `target` だけ。
				const target = event.target;
				if (isHTMLElement(target) && !isAncestor(target, this.contextViewService.getContextViewElement()) && !isAncestor(target, this.chip)) {
					this.details.clear();
				}
			},
			onHide: () => {
				this.chip.classList.remove('active');
				// ほかの context view が開くなど、外から閉じられた。自分で閉じているときは dispose の中なので触らない
				if (!closing && this.details.value === handle) {
					this.details.clear();
				}
			},
		});
		const handle = toDisposable(() => {
			closing = true;
			view.close();
		});
		this.details.value = handle;
	}
}

BrowserEditor.registerContribution(ParadisAgentPageScriptsBanner);

function sourceGoneText(): string {
	return localize('paradis.agentPageScripts.sourceGone', "// このスクリプトは外されたか、本文を保持していません。");
}

/** 「中身を見る」で開く読み取り専用の文書（本文は electron-main から取る）。 */
class ParadisAgentPageScriptContentProvider implements ITextModelContentProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentPageScriptContent';

	private readonly surface: IParadisAgentPageScriptsSurface;
	private readonly registration: IDisposable;
	private readonly changes: IDisposable;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		this.surface = ProxyChannel.toService<IParadisAgentPageScriptsSurface>(mainProcessService.getChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL));
		this.registration = textModelService.registerTextModelContentProvider(PARADIS_AGENT_PAGE_SCRIPT_SCHEME, this);
		// 外されたスクリプトの文書をエディタで開いたままにしても、古い本文が見え続けないようにする
		this.changes = this.surface.onDidChangeInitScripts(change => void paradisRefreshAgentPageScriptModels(
			this.modelService.getModels(), change.viewId, (viewId, id) => this.surface.getInitScriptSource(viewId, id), sourceGoneText()));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const parsed = paradisParseAgentPageScriptUri(resource);
		const source = parsed ? await this.surface.getInitScriptSource(parsed.viewId, parsed.id) : undefined;
		const text = source ?? sourceGoneText();
		return this.modelService.createModel(text, this.languageService.createById('javascript'), resource);
	}

	dispose(): void {
		this.changes.dispose();
		this.registration.dispose();
	}
}

registerWorkbenchContribution2(ParadisAgentPageScriptContentProvider.ID, ParadisAgentPageScriptContentProvider, WorkbenchPhase.AfterRestored);
