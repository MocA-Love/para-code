/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エディタタブのターミナル（`TerminalEditor`）向けに、agent-browser-binding indicator（右上の
// 共有ドット + 背面ハイライト）を配線するだけの差し替えクラス。パネルの `SessionTerminalGridCell`
// （sessionTerminalGridGroup.ts参照）は1セル=1インスタンス使い捨てだが、`TerminalEditor` の
// overflow guard 要素はタブ切り替えの間ずっと再利用されるため、`createParadisEditorTerminalIndicator`
// の `setInstance()` で対象ペインを都度差し替える。
//
// `_overflowGuardElement` / `_editorInput` は `TerminalEditor`側で private のため、DOM
// クエリ（createEditor）とメソッド引数（setInput）だけでアクセスし、既存クラスへは一切手を
// 入れない。差し替えは terminal.contribution.ts の EditorPaneDescriptor.create() 呼び出し
// 1箇所のみ。

import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createParadisEditorTerminalIndicator, IParadisEditorTerminalIndicatorController } from '../../../../paradis/contrib/agentBrowser/browser/paradisPaneIndicator.js';
import { createParadisPromptCacheBadge, IParadisPromptCacheBadgeController } from '../../../../paradis/contrib/agentInsights/browser/paradisPromptCacheBadge.js';
import { paradisReleaseTerminalLayout } from '../../../../paradis/contrib/terminalRenderer/browser/paradisTerminalLayoutHold.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { TerminalEditor } from '../../../../workbench/contrib/terminal/browser/terminalEditor.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';

/**
 * `TerminalEditor` に agent-browser-binding indicator を配線するだけの差し替えクラス。
 * ロジックは一切変更せず、`super` 呼び出し前後にインジケータの配置/対象差し替えを足すのみ。
 */
export class SessionTerminalEditor extends TerminalEditor {

	private _paradisIndicator: IParadisEditorTerminalIndicatorController | undefined;
	/** 共有ドットの左に出すプロンプトキャッシュの残り時間（agentInsights）。 */
	private _paradisPromptCacheBadge: IParadisPromptCacheBadgeController | undefined;
	private _paradisOverflowGuard: HTMLElement | undefined;
	/** 直近の layout の大きさ（重ねた部品の上端の高さが変わったら、これで layout し直す）。 */
	private _paradisLastDimension: Dimension | undefined;
	/** 縮めて親へ渡した大きさ。親は自分の控えでもう一度 layout を呼ぶので、そのときは元の大きさに戻して二重に縮めない。 */
	private _paradisPassedDimension: Dimension | undefined;

	protected override createEditor(parent: HTMLElement): void {
		super.createEditor(parent);
		// overflow guard 要素は TerminalEditor 側で private のため、公開APIに無い代替手段として
		// DOM クエリで取得する（生成直後でこの1要素しか無いため確実に一致する）。
		// eslint-disable-next-line no-restricted-syntax
		const overflowGuard = parent.querySelector<HTMLElement>('.terminal-overflow-guard.terminal-editor');
		if (overflowGuard) {
			this._paradisOverflowGuard = overflowGuard;
			this._paradisIndicator = this._register(createParadisEditorTerminalIndicator(overflowGuard));
			this._paradisPromptCacheBadge = this._register(createParadisPromptCacheBadge(overflowGuard));
			this._register(this._paradisIndicator.onDidChangeTopInset(() => {
				if (this._paradisLastDimension) {
					this.layout(this._paradisLastDimension);
				}
			}));
		}
	}

	/**
	 * 重ねた部品が上端に帯を置いているとき（Bot のページなど）、その分ターミナルの描画の高さを縮め、入れ物の上の余白で
	 * 下げる。xterm は渡した高さで行数を測り直すので、帯がターミナルの行を隠さない。
	 */
	override layout(dimension: Dimension): void {
		const original = dimension === this._paradisPassedDimension && this._paradisLastDimension ? this._paradisLastDimension : dimension;
		this._paradisLastDimension = original;
		const inset = Math.min(this._paradisIndicator?.topInset() ?? 0, Math.max(0, original.height - 1));
		if (this._paradisOverflowGuard) {
			this._paradisOverflowGuard.style.paddingTop = inset > 0 ? `${inset}px` : '';
			this._paradisOverflowGuard.style.boxSizing = inset > 0 ? 'border-box' : '';
		}
		const passed = inset > 0 ? new Dimension(original.width, original.height - inset) : original;
		this._paradisPassedDimension = passed;
		super.layout(passed);
	}

	override async setInput(newInput: TerminalEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		// スペースを離れる間に止めた layout を、開き直すときの layout より前に戻す (paradisTerminalLayoutHold.ts)。
		paradisReleaseTerminalLayout(newInput.terminalInstance);
		await super.setInput(newInput, options, context, token);
		this._paradisIndicator?.setInstance(newInput.terminalInstance?.instanceId);
		this._paradisPromptCacheBadge?.setInstance(newInput.terminalInstance?.instanceId);
	}

	override clearInput(): void {
		super.clearInput();
		this._paradisIndicator?.setInstance(undefined);
		this._paradisPromptCacheBadge?.setInstance(undefined);
	}
}
