/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの URL の上で右クリックしたとき、右クリックメニューの先頭に「リンクをコピー」
// 「内蔵ブラウザで開く」を出す（Q44 B / TM10）。⌘クリックで開く動きは変えない。
//
// どのリンクの上で右クリックしたかは、xterm が下線とヒントを出している「いまマウスが乗っているリンク」
// （xterm の Linkifier の currentLink）をそのまま使う。upstream の terminal link 機構（URL 検出、
// 画面幅で折り返された URL の結合、OSC 8 ハイパーリンク）が見つけたリンクと同じものになるので、
// 検出をやり直さず、upstream のファイルにも手を入れない。
//
// 右クリックのメニューは contextmenu イベントで同期的に組み立てられるため、その前に来る mousedown
// （キャプチャ段階）でリンクを読み取っておき、contextmenu のキャプチャ段階でグローバルの
// コンテキストキーに反映する。メニューを開くたびに、まずウィンドウのキャプチャ段階で消してから
// 入れ直すので、リンクの無い場所（ターミナルの余白など）やキーボードで開いたメニューに、前回の
// リンクが残らない。
// エディタエリアのターミナル（TerminalEditor）とパネルのターミナルは同じ `TerminalInstanceContext`
// メニューを使うので、どちらでも出る。

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Schemas } from '../../../../base/common/network.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalContribution, IXtermTerminal } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';

/**
 * 右クリックしたリンクの文字列が http(s) の URL なら、その URL を返す。
 * ファイルパスや単語のリンク、その他のスキームは対象外（Q44 B は URL のみ）。
 */
export function paradisHttpUrlFromTerminalLinkText(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
		return undefined;
	}
	try {
		const uri = URI.parse(trimmed, true);
		const scheme = uri.scheme.toLowerCase();
		if ((scheme === Schemas.http || scheme === Schemas.https) && uri.authority) {
			return trimmed;
		}
	} catch {
		// 解釈できない文字列はリンクとして扱わない
	}
	return undefined;
}

/** xterm の非公開 API のうち、ここで読むものだけ（プロパティ名は xterm の配布物でも縮められていない）。 */
interface IXtermWithLinkifier {
	readonly _core?: {
		readonly linkifier?: {
			readonly currentLink?: { readonly link?: { readonly text?: string } };
		};
	};
}

/** xterm がいま下線を出しているリンク（マウスが乗っているリンク）の文字列。 */
function hoveredLinkText(raw: RawXtermTerminal): string | undefined {
	return (raw as unknown as IXtermWithLinkifier)._core?.linkifier?.currentLink?.link?.text;
}

const PARADIS_TERMINAL_URL_LINK_AT_MOUSE = new RawContextKey<boolean>('paradisTerminalUrlLinkAtMouse', false, localize('paradisTerminalUrlLinkAtMouse', "ターミナルで右クリックした位置に URL のリンクがあるかどうか"));

const IParadisTerminalLinkAtMouseService = createDecorator<IParadisTerminalLinkAtMouseService>('paradisTerminalLinkAtMouseService');

/** 最後に右クリックしたターミナルのリンク。コンテキストキーはグローバル（メニューのスコープから見える位置）に置く。 */
interface IParadisTerminalLinkAtMouseService {
	readonly _serviceBrand: undefined;
	readonly url: string | undefined;
	setUrl(url: string | undefined): void;
}

class ParadisTerminalLinkAtMouseService implements IParadisTerminalLinkAtMouseService {
	declare readonly _serviceBrand: undefined;

	private _url: string | undefined;
	private readonly _hasUrl: IContextKey<boolean>;

	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		this._hasUrl = PARADIS_TERMINAL_URL_LINK_AT_MOUSE.bindTo(contextKeyService);
	}

	get url(): string | undefined {
		return this._url;
	}

	setUrl(url: string | undefined): void {
		this._url = url;
		this._hasUrl.set(url !== undefined);
	}
}

registerSingleton(IParadisTerminalLinkAtMouseService, ParadisTerminalLinkAtMouseService, InstantiationType.Delayed);

/** 右クリック（macOS の Control+クリックを含む）か。 */
function isSecondaryClick(event: MouseEvent, isMac: boolean): boolean {
	return event.button === 2 || (isMac && event.button === 0 && event.ctrlKey);
}

/**
 * 1つのターミナルについて、メニューを開くたびに「右クリックしたリンク」を取り直す。
 *
 * - `root`（ターミナルのあるウィンドウ）のキャプチャ段階で、どこで開かれたメニューでもまず消す。
 *   ウィンドウのキャプチャはターミナル要素のキャプチャより先に走る
 * - ターミナル要素の上で開かれたときだけ、右クリックを押した時点のリンクを入れ直す。押した後に
 *   upstream が単語を選択するなどして、xterm がリンクの下線を外すことがあるので、押した時点で取る
 */
export function paradisTrackTerminalLinkAtMouse(
	root: EventTarget,
	element: HTMLElement,
	hoveredLinkText: () => string | undefined,
	setUrl: (url: string | undefined) => void,
	isMac: boolean = isMacintosh,
): IDisposable {
	const store = new DisposableStore();
	let pressed: string | undefined;
	store.add(addDisposableListener(element, EventType.MOUSE_DOWN, (event: MouseEvent) => {
		pressed = isSecondaryClick(event, isMac) ? paradisHttpUrlFromTerminalLinkText(hoveredLinkText()) : undefined;
	}, true));
	store.add(addDisposableListener(element, EventType.KEY_DOWN, () => {
		pressed = undefined;
		setUrl(undefined);
	}, true));
	store.add(addDisposableListener(root, EventType.CONTEXT_MENU, () => setUrl(undefined), true));
	store.add(addDisposableListener(element, EventType.CONTEXT_MENU, () => {
		setUrl(pressed);
		pressed = undefined;
	}, true));
	return store;
}

/** 各ターミナルで、右クリックの直前にマウスの下のリンクを読み取る。 */
class ParadisTerminalLinkAtMouseContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'paradis.terminal.linkAtMouse';

	constructor(
		_ctx: ITerminalContributionContext,
		@IParadisTerminalLinkAtMouseService private readonly _linkAtMouse: IParadisTerminalLinkAtMouseService,
	) {
		super();
	}

	xtermOpen(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		const element = xterm.raw.element;
		if (!element) {
			return;
		}
		this._register(paradisTrackTerminalLinkAtMouse(
			getWindow(element),
			element,
			() => hoveredLinkText(xterm.raw),
			url => this._linkAtMouse.setUrl(url),
		));
	}
}

registerTerminalContribution(ParadisTerminalLinkAtMouseContribution.ID, ParadisTerminalLinkAtMouseContribution);

/** upstream の TerminalContextMenuGroup.Chat ('0_chat') より前、メニューの先頭に置く。 */
const PARADIS_TERMINAL_LINK_MENU_GROUP = '0_0_paradisLink';

export const enum ParadisTerminalLinkCommandId {
	CopyLink = 'paradis.terminal.copyLinkAtMouse',
	OpenLinkInIntegratedBrowser = 'paradis.terminal.openLinkAtMouseInIntegratedBrowser',
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ParadisTerminalLinkCommandId.CopyLink,
			title: localize2('paradis.terminal.copyLink', "リンクをコピー"),
			menu: {
				id: MenuId.TerminalInstanceContext,
				group: PARADIS_TERMINAL_LINK_MENU_GROUP,
				order: 1,
				when: PARADIS_TERMINAL_URL_LINK_AT_MOUSE,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const url = accessor.get(IParadisTerminalLinkAtMouseService).url;
		if (url) {
			await accessor.get(IClipboardService).writeText(url);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ParadisTerminalLinkCommandId.OpenLinkInIntegratedBrowser,
			title: localize2('paradis.terminal.openLinkInIntegratedBrowser', "内蔵ブラウザで開く"),
			menu: {
				id: MenuId.TerminalInstanceContext,
				group: PARADIS_TERMINAL_LINK_MENU_GROUP,
				order: 2,
				// 内蔵ブラウザ（browserView）はデスクトップ版にだけある
				when: ContextKeyExpr.and(PARADIS_TERMINAL_URL_LINK_AT_MOUSE, IsWebContext.negate()),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const url = accessor.get(IParadisTerminalLinkAtMouseService).url;
		if (url) {
			await accessor.get(ICommandService).executeCommand(BrowserViewCommandId.Open, url);
		}
	}
});
