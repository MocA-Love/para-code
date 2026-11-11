/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中央のパレットの右のプレビュー（Q609 の 2、mock/ui/palette-ideas.html の案 11）。選んだ行の中身を、一覧の右の面に出す。
// 器の幅と面の幅は platform の paradisQuickInputLayout.ts（quickInputController.ts の PARA-PATCH）が決め、ここは面の中身だけ。
//
// - エージェント: 状態・スペース・ブランチ・モデル・最後の発言（agentInsights が知っている分）
// - スペース: リポジトリ・ブランチ・状態・PR・差分（Workspaces ビューと同じ内部コマンドで取る）
// - タブ: 場所とファイルの先頭。色付けは本家の tokenizeToString（テーマの色）、Markdown は fork の Markdown ビューアと同じ
//   変換と消毒（renderParadisMarkdownDocumentDeferred）で描く。スクリプトは動かさず、リンクと画像は外す（面は押せない）
// - コマンド: 英語の名前とキー
// 読み込み（ファイル・差分・PR）は選んだ行が止まってから（PREVIEW_DELAY_MS）始め、行が替わったら取りやめる。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { paradisQuickInputPreviewTier } from '../../../../platform/quickinput/browser/paradisQuickInputLayout.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { markedParadisAlertExtension } from '../../fileViewers/browser/paradisMarkdownAlerts.js';
import { parseParadisTokenizedCode, renderParadisMarkdownDocumentDeferred } from '../../fileViewers/browser/paradisMarkdownDocumentRenderer.js';

/** 面のクラス。 */
export const PARADIS_PALETTE_PREVIEW_CLASS = 'paradis-palette-preview';

/** 読み込みを始めるまでの待ち（↑↓ で行を送っている間は読まない）。 */
const PREVIEW_DELAY_MS = 150;
/** ファイルの先頭として読む量の上限と、出す行の上限。 */
export const PARADIS_PALETTE_PREVIEW_MAX_BYTES = 64 * 1024;
export const PARADIS_PALETTE_PREVIEW_MAX_LINES = 120;

/** 面に出すもの。 */
export type ParadisPalettePreviewModel =
	| {
		readonly kind: 'agent';
		readonly title: string;
		readonly statusTone: string;
		readonly status: string;
		readonly space: string;
		readonly branch: string | undefined;
		readonly model: string | undefined;
		readonly lastMessage: string | undefined;
	}
	| {
		readonly kind: 'space';
		readonly title: string;
		readonly icon: ThemeIcon;
		readonly repository: string;
		readonly branch: string | undefined;
		readonly status: string;
		/** 差分と PR を取る先（スペースのルート）。 */
		readonly root: URI;
	}
	| {
		readonly kind: 'editor';
		readonly title: string;
		readonly location: string | undefined;
		/** 先頭を出すファイル。中身がテキストでないビューア（Office・画像・PDF・ターミナルなど）のタブは undefined。 */
		readonly resource: URI | undefined;
	}
	| {
		readonly kind: 'command';
		readonly title: string;
		readonly alias: string | undefined;
		readonly keybinding: string | undefined;
	}
	| {
		readonly kind: 'other';
		readonly title: string;
		readonly icon: ThemeIcon;
		readonly kindName: string;
		readonly keybinding: string | undefined;
	};

/** 差分の統計（Workspaces ビューと同じ内部コマンドの結果の形）。 */
interface IDiffStat {
	readonly insertions: number;
	readonly deletions: number;
	readonly failed?: true;
}

/** PR の状態（同上）。 */
interface IPrStatus {
	readonly number: number;
	readonly title: string;
	readonly state: string;
}

/** Workspaces ビューが使う内部コマンド（electron-browser の登録元を import すると登録の副作用が走るので ID だけ持つ）。 */
const GET_DIFF_STATS_COMMAND_ID = 'paradis.workspaceSwitch.getDiffStats';
const GET_PR_STATUSES_COMMAND_ID = 'paradis.workspaceSwitch.getPrStatuses';

/** ファイルの先頭を、出す行の上限で切る。切ったら true。 */
export function paradisPalettePreviewHead(text: string): { readonly text: string; readonly truncated: boolean } {
	const lines = text.split(/\r?\n/);
	if (lines.length <= PARADIS_PALETTE_PREVIEW_MAX_LINES) {
		return { text, truncated: false };
	}
	return { text: lines.slice(0, PARADIS_PALETTE_PREVIEW_MAX_LINES).join('\n'), truncated: true };
}

/** 先頭の何バイトに NUL があればバイナリとみなすか（本家のテキストのエディタと同じく、NUL の有無で見分ける）。 */
export const PARADIS_PALETTE_PREVIEW_BINARY_SNIFF_BYTES = 4096;

/** 先頭に NUL があるか（バイナリのファイルを文字として出さない）。 */
export function paradisLooksBinary(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, PARADIS_PALETTE_PREVIEW_BINARY_SNIFF_BYTES);
	for (let index = 0; index < end; index++) {
		if (bytes[index] === 0) {
			return true;
		}
	}
	return false;
}

/**
 * タブの先頭を面に出せるか。中身がテキストでないビューア（`blockedTypeIds`）だけを弾き、残り（テキストのエディタ、
 * Markdown・HTML・CSV のビューア、差分、git の旧版、untitled など）は読めれば出す（中身がバイナリなら NUL の判定で弾く）。
 */
export function paradisCanPreviewEditor(typeId: string, blockedTypeIds: ReadonlySet<string>, readable: boolean): boolean {
	return readable && !blockedTypeIds.has(typeId);
}

/** 面の本文に「プレビューできません」を出す。 */
function showUnavailable(body: HTMLElement): void {
	dom.append(body, dom.$('.paradis-palette-preview-empty')).textContent = localize('paradis.palette.preview.unavailable', "このタブはプレビューできません");
}

/** 今の窓でプレビューを出せるか（窓が狭くて出せないときは undefined、出せるなら設定の on/off）。 */
export function paradisPalettePreviewState(windowWidth: number, enabled: boolean): boolean | undefined {
	return paradisQuickInputPreviewTier(windowWidth) ? enabled : undefined;
}

/** Markdown として描くファイルか。 */
export function paradisIsPalettePreviewMarkdown(resource: URI, languageId: string | null): boolean {
	return languageId === 'markdown' || /\.(md|markdown|mdx)$/i.test(resource.path);
}

/** 面は押せないので、リンクは文字に、画像（外へ取りに行く）は代わりの文字にする。 */
function disarmPreviewMarkdown(element: Element): void {
	for (const child of [...element.children]) {
		if (child.tagName === 'IMG') {
			child.replaceWith(child.getAttribute('alt') ?? '');
			continue;
		}
		if (child.tagName === 'A') {
			child.removeAttribute('href');
		}
		disarmPreviewMarkdown(child);
	}
}

/** 一覧の右に置くプレビューの面。dispose で器から外す。 */
export class ParadisPalettePreviewPane extends Disposable {

	readonly element: HTMLElement;
	private readonly pending = this._register(new MutableDisposable());
	private current: ParadisPalettePreviewModel | undefined;

	constructor(
		listContainer: HTMLElement,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@ICommandService private readonly commandService: ICommandService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();
		this.element = dom.append(listContainer, dom.$(`.${PARADIS_PALETTE_PREVIEW_CLASS}`));
		// 面は読むだけ。押しても入力欄からフォーカスを奪わない（器の外へフォーカスが出ると本家が閉じる）
		this.element.setAttribute('aria-hidden', 'true');
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_DOWN, event => event.preventDefault()));
		this._register({ dispose: () => this.element.remove() });
		this.show(undefined);
	}

	/** 選んだ行の中身を出す（同じものなら何もしない）。 */
	show(model: ParadisPalettePreviewModel | undefined): void {
		if (model && this.current && JSON.stringify(model) === JSON.stringify(this.current)) {
			return;
		}
		this.current = model;
		this.pending.clear();
		dom.clearNode(this.element);
		if (!model) {
			dom.append(this.element, dom.$('.paradis-palette-preview-empty')).textContent = localize('paradis.palette.preview.empty', "選んだ行の中身がここに出ます");
			return;
		}
		const head = dom.append(this.element, dom.$('.paradis-palette-preview-head'));
		if (model.kind === 'agent') {
			dom.append(head, dom.$(`span.paradis-palette-preview-dot.paradis-palette-dot-${model.statusTone}`));
		} else {
			const icon = model.kind === 'space' || model.kind === 'other' ? model.icon : model.kind === 'editor' ? Codicon.file : Codicon.chevronRight;
			dom.append(head, dom.$(ThemeIcon.asCSSSelector(icon)));
		}
		dom.append(head, dom.$('span.paradis-palette-preview-title')).textContent = model.title;

		const meta = dom.append(this.element, dom.$('dl.paradis-palette-preview-meta'));
		const row = (label: string, value: string | undefined) => {
			dom.append(meta, dom.$('dt')).textContent = label;
			const dd = dom.append(meta, dom.$('dd'));
			dd.textContent = value ?? '';
			return dd;
		};
		const none = localize('paradis.palette.preview.none', "なし");
		switch (model.kind) {
			case 'agent': {
				row(localize('paradis.palette.preview.status', "状態"), model.status);
				row(localize('paradis.palette.preview.space', "スペース"), model.space);
				row(localize('paradis.palette.preview.branch', "ブランチ"), model.branch ?? none);
				row(localize('paradis.palette.preview.model', "モデル"), model.model ?? localize('paradis.palette.preview.unknown', "不明"));
				const quote = dom.append(this.element, dom.$('.paradis-palette-preview-quote'));
				quote.textContent = model.lastMessage ?? localize('paradis.palette.preview.noMessage', "まだ発言はありません");
				quote.classList.toggle('empty', model.lastMessage === undefined);
				break;
			}
			case 'space': {
				row(localize('paradis.palette.preview.repository', "リポジトリ"), model.repository);
				row(localize('paradis.palette.preview.branch', "ブランチ"), model.branch ?? none);
				row(localize('paradis.palette.preview.status', "状態"), model.status);
				const pr = row(localize('paradis.palette.preview.pr', "PR"), localize('paradis.palette.preview.loading', "読み込み中..."));
				const diff = row(localize('paradis.palette.preview.diff', "差分"), localize('paradis.palette.preview.loading', "読み込み中..."));
				this.later(token => this.loadSpace(model.root, pr, diff, () => token.isCancellationRequested));
				break;
			}
			case 'editor': {
				row(localize('paradis.palette.preview.location', "場所"), model.location || localize('paradis.palette.preview.root', "（ルート）"));
				const body = dom.append(this.element, dom.$('.paradis-palette-preview-body'));
				if (model.resource) {
					const resource = model.resource;
					this.later(token => this.loadFile(resource, body, token));
				} else {
					showUnavailable(body);
				}
				break;
			}
			case 'command':
				row(localize('paradis.palette.preview.alias', "英語"), model.alias ?? none);
				row(localize('paradis.palette.preview.keybinding', "キー"), model.keybinding ?? localize('paradis.palette.preview.noKeybinding', "割り当てなし"));
				break;
			case 'other':
				row(localize('paradis.palette.preview.kind', "種類"), model.kindName);
				row(localize('paradis.palette.preview.keybinding', "キー"), model.keybinding ?? localize('paradis.palette.preview.noKeybinding', "割り当てなし"));
				break;
		}
	}

	/** 選んだ行が止まってから読み込む。行が替わったら取りやめる。 */
	private later(load: (token: CancellationToken) => Promise<void>): void {
		const source = new CancellationTokenSource();
		const handle = dom.getWindow(this.element).setTimeout(() => void load(source.token).catch(() => { /* 面の読み込みの失敗は出さない */ }), PREVIEW_DELAY_MS);
		this.pending.value = {
			dispose: () => {
				dom.getWindow(this.element).clearTimeout(handle);
				source.dispose(true);
			}
		};
	}

	private async loadSpace(root: URI, pr: HTMLElement, diff: HTMLElement, cancelled: () => boolean): Promise<void> {
		// 結果は作業ツリーのパス（fsPath）ごと（paradisCollectPerWorktree）
		const key = root.fsPath;
		const [diffs, prs] = await Promise.all([
			this.commandService.executeCommand<Record<string, IDiffStat>>(GET_DIFF_STATS_COMMAND_ID, [root]).catch(() => undefined),
			this.commandService.executeCommand<Record<string, IPrStatus>>(GET_PR_STATUSES_COMMAND_ID, [root]).catch(() => undefined),
		]);
		if (cancelled()) {
			return;
		}
		const prStatus = prs?.[key];
		pr.textContent = prStatus ? localize('paradis.palette.preview.prValue', "#{0} {1}", prStatus.number, prStatus.title) : localize('paradis.palette.preview.none', "なし");
		const stat = diffs?.[key];
		dom.clearNode(diff);
		if (!stat || stat.failed) {
			diff.textContent = localize('paradis.palette.preview.diffUnknown', "取得できませんでした");
		} else if (stat.insertions === 0 && stat.deletions === 0) {
			diff.textContent = localize('paradis.palette.preview.noChanges', "変更なし");
		} else {
			dom.append(diff, dom.$('span.paradis-palette-preview-add')).textContent = `+${stat.insertions}`;
			diff.append(' ');
			// allow-any-unicode-next-line
			dom.append(diff, dom.$('span.paradis-palette-preview-del')).textContent = `−${stat.deletions}`;
		}
	}

	private async loadFile(resource: URI, body: HTMLElement, token: CancellationToken): Promise<void> {
		const cancelled = () => token.isCancellationRequested;
		// 開いている文書（untitled・保存していない変更・git の旧版など）は、その文字を使う
		const model = this.modelService.getModel(resource);
		let text: string;
		if (model) {
			const lastLine = Math.min(model.getLineCount(), PARADIS_PALETTE_PREVIEW_MAX_LINES);
			text = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: lastLine, endColumn: model.getLineMaxColumn(lastLine) });
		} else {
			// 行が替わったら読み込みも止める
			const content = await this.fileService.readFile(resource, { length: PARADIS_PALETTE_PREVIEW_MAX_BYTES }, token);
			if (cancelled()) {
				return;
			}
			if (paradisLooksBinary(content.value.buffer)) {
				showUnavailable(body);
				return;
			}
			text = content.value.toString();
		}
		const truncatedByModel = !!model && model.getLineCount() > PARADIS_PALETTE_PREVIEW_MAX_LINES;
		const head = paradisPalettePreviewHead(text);
		const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(resource, head.text.split('\n', 1)[0]);
		if (paradisIsPalettePreviewMarkdown(resource, languageId)) {
			await this.renderMarkdown(head.text, body, cancelled);
		} else {
			await this.renderCode(head.text, languageId, body, cancelled);
		}
		if ((head.truncated || truncatedByModel) && !cancelled()) {
			dom.append(body, dom.$('.paradis-palette-preview-more')).textContent = localize('paradis.palette.preview.more', "先頭の {0} 行だけを出しています", PARADIS_PALETTE_PREVIEW_MAX_LINES);
		}
	}

	private async renderCode(text: string, languageId: string | null, body: HTMLElement, cancelled: () => boolean): Promise<void> {
		await this.extensionService.whenInstalledExtensionsRegistered();
		const html = await tokenizeToString(this.languageService, text, languageId);
		if (cancelled()) {
			return;
		}
		const pre = dom.append(body, dom.$('pre.paradis-palette-preview-code'));
		const segments = parseParadisTokenizedCode(html);
		if (!segments) {
			pre.textContent = text;
			return;
		}
		// 色付けの結果は決まった形（span と br だけ）なので、DOM の API で組み立てる（文字は text node）
		for (const segment of segments) {
			if (segment === undefined) {
				pre.append('\n');
			} else {
				dom.append(pre, dom.$(`span.${segment.className.split(' ').join('.')}`)).textContent = segment.text;
			}
		}
	}

	private async renderMarkdown(text: string, body: HTMLElement, cancelled: () => boolean): Promise<void> {
		const source = new CancellationTokenSource();
		try {
			const rendered = await renderParadisMarkdownDocumentDeferred(text, this.extensionService, this.languageService, { markedExtensions: [markedParadisAlertExtension()] }, source.token);
			if (cancelled()) {
				return;
			}
			// Markdown ビューアと同じ消毒の済んだ HTML を、別の文書で解析してから移す（スクリプトは動かない）
			const parsed = new DOMParser().parseFromString(rendered.html as unknown as string, 'text/html');
			rendered.insertHighlightedCode(parsed.body);
			disarmPreviewMarkdown(parsed.body);
			const markdown = dom.append(body, dom.$('.paradis-palette-preview-markdown'));
			markdown.append(...[...parsed.body.childNodes].map(node => dom.getWindow(body).document.importNode(node, true)));
		} finally {
			source.dispose();
		}
	}
}
