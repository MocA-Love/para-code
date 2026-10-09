/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのタブに、エージェントが置いたスクリプト（add_init_script）が入っている間、ナビバーの下に
// 帯を出す。スクリプトはページを読み込むたびに動き、利用者がそのタブで見るページにも効くので、入っていることと
// 「誰が・何を」入れたかが見えるようにする（q.html の Q300、案 C）。
//
//  - 帯: いちばん新しい 1 本の名前と持ち主（C/X・名札・ペイン番号）、ほかの本数、「詳細」「すべて外す」
//  - 「詳細」: 一覧（名前・持ち主・時刻・大きさ・先頭 3 行）。1 本ずつ外せ、「中身を見る」で全文を読み取り専用の
//    エディタに開く
//
// 一覧と本文は electron-main から PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL で取る（タブ＝BrowserView の id ごと）。
// 一覧はブラウザのページに重なるので、内蔵ブラウザが前面の DOM を検知して一時的に退く `context-view`
// （IContextViewService）で出す。upstream のファイルには触らず、BrowserEditor.registerContribution() の拡張点だけで足している。

import './media/paradisAgentPageScriptsBanner.css';
import { $, addDisposableListener, append, clearNode, EventType, isAncestor, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisAgentPageScriptEntry, IParadisAgentPageScriptOwner, IParadisAgentPageScriptsSurface, paradisAgentPageScriptUri, paradisPaneFingerprint, paradisParseAgentPageScriptUri, PARADIS_AGENT_PAGE_SCRIPT_SCHEME, PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL } from '../common/paradisAgentBrowser.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';

/** Toolbar の帯の並び順（Design Mode のトレイより上に出す）。 */
const BANNER_ORDER = 5;

/** 置いた時刻（時:分:秒）。 */
function timeOf(addedAt: number): string {
	const date = new Date(addedAt);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** 持ち主の印・名札・ペイン番号を出す小さな札。色は main で `#rrggbb` に限ってある。 */
function appendOwnerChip(parent: HTMLElement, owner: IParadisAgentPageScriptOwner | undefined, paneOf: (fingerprint: string) => number | undefined): void {
	if (!owner) {
		return;
	}
	const chip = append(parent, $('span.paradis-page-scripts-owner'));
	chip.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(owner.color) ? owner.color : '';
	if (owner.mark) {
		append(chip, $('b.paradis-page-scripts-owner-mark')).textContent = owner.mark;
	}
	const pane = paneOf(owner.pane);
	append(chip, $('span')).textContent = pane === undefined
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

/** タブにエージェントのスクリプトが入っている間だけ出す帯。 */
export class ParadisAgentPageScriptsBanner extends BrowserEditorContribution {

	private readonly surface: IParadisAgentPageScriptsSurface;
	private readonly banner: HTMLElement;
	private readonly label: HTMLElement;
	private readonly detailsButton: HTMLButtonElement;
	private readonly removeButton: HTMLButtonElement;
	private readonly details = this._register(new MutableDisposable<IDisposable>());
	private visible = false;
	private entries: readonly IParadisAgentPageScriptEntry[] = [];
	/** 一覧を取り直す世代（古い応答で新しい表示を上書きしない）。 */
	private refreshGeneration = 0;

	constructor(
		editor: BrowserEditor,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
	) {
		super(editor);
		this.surface = ProxyChannel.toService<IParadisAgentPageScriptsSurface>(mainProcessService.getChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL));
		this.banner = $('.paradis-page-scripts-banner');
		this.banner.setAttribute('role', 'status');
		this.banner.style.display = 'none';
		this.label = append(this.banner, $('span.paradis-page-scripts-banner-text'));
		this.detailsButton = append(this.banner, $<HTMLButtonElement>('button.paradis-page-scripts-banner-button'));
		this.detailsButton.type = 'button';
		this.detailsButton.textContent = localize('paradis.agentPageScripts.details', "詳細");
		this.detailsButton.title = localize('paradis.agentPageScripts.detailsTitle', "このタブに入っているスクリプトの一覧を開きます。");
		this.detailsButton.setAttribute('aria-haspopup', 'dialog');
		this._register(addDisposableListener(this.detailsButton, EventType.CLICK, () => this.toggleDetails()));
		this.removeButton = append(this.banner, $<HTMLButtonElement>('button.paradis-page-scripts-banner-button'));
		this.removeButton.type = 'button';
		this.removeButton.textContent = localize('paradis.agentPageScripts.removeAll', "すべて外す");
		this.removeButton.title = localize('paradis.agentPageScripts.removeTitle', "このタブからエージェントのスクリプトをすべて外します。読み込み済みのページは、再読み込みするまでスクリプトの効果が残ります。");
		this._register(addDisposableListener(this.removeButton, EventType.CLICK, () => void this.removeAll()));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.banner, order: BANNER_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(this.surface.onDidChangeInitScripts(change => {
			if (change.viewId === model.id) {
				void this.refresh(model);
			}
		}));
		this.render([]);
		void this.refresh(model);
	}

	override onModelDetached(): void {
		this.refreshGeneration++;
		this.details.clear();
		this.render([]);
	}

	/** 一覧を取り直して帯（と開いていれば一覧）を描き直す。 */
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
		this.render(entries);
	}

	/** ペインの指紋 → ターミナルの番号（このウィンドウのペインだけ。ほかのウィンドウのものは分からない）。 */
	private paneNumbers(): (fingerprint: string) => number | undefined {
		const byFingerprint = new Map<string, number>();
		for (const { instanceId, token } of this.paneTokenService.listPaneTokens()) {
			byFingerprint.set(paradisPaneFingerprint(token), instanceId);
		}
		return fingerprint => byFingerprint.get(fingerprint);
	}

	private async removeAll(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		this.removeButton.disabled = true;
		try {
			await this.surface.removeAllInitScripts(model.id);
		} catch (error) {
			this.logService.warn('[ParadisAgentPageScripts] could not remove the scripts of the tab', error);
		} finally {
			this.removeButton.disabled = false;
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

	private render(entries: readonly IParadisAgentPageScriptEntry[]): void {
		this.entries = entries;
		clearNode(this.label);
		const latest = entries[entries.length - 1];
		if (latest) {
			const paneOf = this.paneNumbers();
			append(this.label, $('span')).textContent = localize('paradis.agentPageScripts.bannerPrefix', "エージェントのスクリプト:");
			appendScriptName(this.label, latest, 'paradis-page-scripts-banner-name');
			appendOwnerChip(this.label, latest.owner, paneOf);
			if (entries.length > 1) {
				append(this.label, $('span')).textContent = localize('paradis.agentPageScripts.others', "ほか {0} 本", entries.length - 1);
			}
			this.label.title = localize('paradis.agentPageScripts.bannerTitle', "このタブにエージェントのスクリプトが入っています（{0} 本）。ページを読み込むたびに動きます。", entries.length);
		}
		const visible = entries.length > 0;
		if (!visible) {
			this.details.clear();
		} else if (this.details.value) {
			// 開いている一覧も描き直す
			this.showDetails();
		}
		if (visible !== this.visible) {
			this.visible = visible;
			this.banner.style.display = visible ? '' : 'none';
			// 帯の高さの分だけページの領域が変わるので、ネイティブのビューの位置を合わせ直す
			this.editor.layoutBrowserContainer();
		}
	}

	private toggleDetails(): void {
		if (this.details.value) {
			this.details.clear();
		} else {
			this.showDetails();
		}
	}

	/** 一覧を出す（新しい順）。ブラウザのページに重なるので context view で出す。 */
	private showDetails(): void {
		const entries = this.entries;
		const paneOf = this.paneNumbers();
		this.detailsButton.classList.add('active');
		const view = this.contextViewService.showContextView({
			getAnchor: () => this.detailsButton,
			anchorAlignment: AnchorAlignment.RIGHT,
			anchorPosition: AnchorPosition.BELOW,
			render: container => {
				const store = new DisposableStore();
				const popover = append(container, $('.paradis-page-scripts-details'));
				popover.setAttribute('role', 'dialog');
				popover.setAttribute('aria-label', localize('paradis.agentPageScripts.detailsLabel', "このタブのエージェントのスクリプト"));
				const header = append(popover, $('.paradis-page-scripts-details-header'));
				append(header, $('span.paradis-page-scripts-details-title')).textContent = localize('paradis.agentPageScripts.detailsHeader', "このタブのエージェントのスクリプト（{0} 本）・新しい順", entries.length);
				const removeAll = append(header, $<HTMLButtonElement>('button.paradis-page-scripts-details-button'));
				removeAll.type = 'button';
				removeAll.textContent = localize('paradis.agentPageScripts.removeAll', "すべて外す");
				store.add(addDisposableListener(removeAll, EventType.CLICK, () => void this.removeAll()));
				const close = append(header, $<HTMLButtonElement>('button.paradis-page-scripts-details-button'));
				close.type = 'button';
				close.textContent = localize('paradis.agentPageScripts.close', "閉じる");
				store.add(addDisposableListener(close, EventType.CLICK, () => this.details.clear()));

				const list = append(popover, $('.paradis-page-scripts-details-list'));
				for (const entry of [...entries].reverse()) {
					const row = append(list, $('.paradis-page-scripts-details-row'));
					const first = append(row, $('.paradis-page-scripts-details-name'));
					appendScriptName(first, entry, 'paradis-page-scripts-details-label');
					appendOwnerChip(first, entry.owner, paneOf);
					append(row, $('.paradis-page-scripts-details-meta')).textContent = localize(
						'paradis.agentPageScripts.meta', "{0} · {1} に入れた · {2} 字 · {3} 行",
						entry.id, timeOf(entry.addedAt), entry.chars.toLocaleString(), entry.lines.toLocaleString());
					append(row, $('pre.paradis-page-scripts-details-preview')).textContent = entry.preview;
					const actions = append(row, $('.paradis-page-scripts-details-actions'));
					const view = append(actions, $<HTMLButtonElement>('button.paradis-page-scripts-details-button'));
					view.type = 'button';
					view.textContent = localize('paradis.agentPageScripts.view', "中身を見る");
					if (entry.sourceKept) {
						store.add(addDisposableListener(view, EventType.CLICK, () => this.openSource(entry)));
					} else {
						view.disabled = true;
						view.title = localize('paradis.agentPageScripts.sourceNotKept', "スクリプトが多いため、この本文は保持していません。");
					}
					const remove = append(actions, $<HTMLButtonElement>('button.paradis-page-scripts-details-button'));
					remove.type = 'button';
					remove.textContent = localize('paradis.agentPageScripts.remove', "外す");
					store.add(addDisposableListener(remove, EventType.CLICK, () => void this.removeOne(entry.id)));
				}
				append(popover, $('.paradis-page-scripts-details-footer')).textContent = localize('paradis.agentPageScripts.detailsFooter', "外しても、読み込み済みのページは再読み込みするまで効果が残ります。");
				store.add(addDisposableListener(popover, EventType.KEY_DOWN, event => {
					if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
						event.preventDefault();
						this.details.clear();
						this.detailsButton.focus();
					}
				}));
				return store;
			},
			onDOMEvent: (event: { readonly target?: EventTarget | null }) => {
				// 既定では「ワークベンチの外」でしか閉じないので、一覧と「詳細」の外を押したら閉じる。
				// ここへ来るイベントは包まれていて `type` を持たないので、見るのは `target` だけ。
				const target = event.target;
				if (isHTMLElement(target) && !isAncestor(target, this.contextViewService.getContextViewElement()) && !isAncestor(target, this.detailsButton)) {
					this.details.clear();
				}
			},
			onHide: () => {
				this.detailsButton.classList.remove('active');
				if (this.details.value === handle) {
					this.details.clearAndLeak();
				}
			},
		});
		const handle: IDisposable = { dispose: () => view.close() };
		this.details.value = handle;
	}
}

BrowserEditor.registerContribution(ParadisAgentPageScriptsBanner);

/** 「中身を見る」で開く読み取り専用の文書（本文は electron-main から取る）。 */
class ParadisAgentPageScriptContentProvider implements ITextModelContentProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentPageScriptContent';

	private readonly surface: IParadisAgentPageScriptsSurface;
	private readonly registration: IDisposable;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		this.surface = ProxyChannel.toService<IParadisAgentPageScriptsSurface>(mainProcessService.getChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL));
		this.registration = textModelService.registerTextModelContentProvider(PARADIS_AGENT_PAGE_SCRIPT_SCHEME, this);
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const parsed = paradisParseAgentPageScriptUri(resource);
		const source = parsed ? await this.surface.getInitScriptSource(parsed.viewId, parsed.id) : undefined;
		const text = source ?? localize('paradis.agentPageScripts.sourceGone', "// このスクリプトは外されたか、本文を保持していません。");
		return this.modelService.createModel(text, this.languageService.createById('javascript'), resource);
	}

	dispose(): void {
		this.registration.dispose();
	}
}

registerWorkbenchContribution2(ParadisAgentPageScriptContentProvider.ID, ParadisAgentPageScriptContentProvider, WorkbenchPhase.AfterRestored);
