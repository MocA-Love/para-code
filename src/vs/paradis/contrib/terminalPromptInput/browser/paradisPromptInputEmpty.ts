/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「シェルが入力を待っていて入力欄が空か」を右プロンプト（zsh の RPROMPT）込みで判定する入り口。
// 判定そのものは `common/paradisPromptInputEmpty.ts`（純関数）。ここではシェル統合ごとに、プロンプトが出た直後の
// 入力欄の値（基準）を覚えておく。基準はプロンプトが出た瞬間から追う必要があるので、ターミナルを作った時点で
// `paradisTrackPromptInputBaseline` を呼ぶ（`paradisPromptInputEmpty.contribution.ts`）。
//
// 既知の制約: 空と読めても、zsh の vi モードでノーマルモードにいると、続けて送った文字の先頭が vi のコマンドとして
// 解釈される（入力欄の様子からはモードが分からないので、ここでは見分けない）。

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IPromptInputModel } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { ICurrentPartialCommand } from '../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import { IParadisPromptBaseline, PARADIS_PROMPT_BASELINE_START, paradisIsPromptInputEmpty, paradisNextPromptBaseline } from '../common/paradisPromptInputEmpty.js';

/** 判定に使うシェル統合の一部（`ICommandDetectionCapability` がそのまま渡せる）。 */
export interface IParadisPromptInputSource {
	readonly executingCommand: string | undefined;
	readonly currentCommand: Pick<ICurrentPartialCommand, 'commandStartX' | 'commandRightPromptStartX' | 'commandRightPromptEndX'> | undefined;
	readonly promptInputModel: Pick<IPromptInputModel, 'value' | 'cursorIndex'> & {
		readonly onDidStartInput: Event<unknown>;
		readonly onDidChangeInput: Event<{ readonly value: string; readonly cursorIndex: number }>;
		readonly onDidFinishInput: Event<unknown>;
	};
}

/** シェル統合ごとの基準。シェル統合が外れたら一緒に消える。 */
const baselines = new WeakMap<IParadisPromptInputSource, IParadisPromptBaseline>();

/**
 * シェルが入力を待っていて、入力欄が空か（右プロンプトだけが出ている状態も空と読む）。
 * 決めきれないときは false。
 */
export function paradisIsAtEmptyPrompt(source: IParadisPromptInputSource): boolean {
	return source.executingCommand === undefined && paradisIsPromptInputEmptyFor(source);
}

/**
 * 入力欄が空か（実行中かどうかは見ない）。決めきれないときは false。
 */
export function paradisIsPromptInputEmptyFor(source: IParadisPromptInputSource): boolean {
	const model = source.promptInputModel;
	const currentCommand = source.currentCommand;
	return paradisIsPromptInputEmpty({
		value: model.value,
		cursorIndex: model.cursorIndex,
		commandStartX: currentCommand?.commandStartX,
		rightPromptStartX: currentCommand?.commandRightPromptStartX,
		rightPromptEndX: currentCommand?.commandRightPromptEndX,
		baseline: baselines.get(source)?.value,
	});
}

/**
 * プロンプトが出た直後の入力欄の値を追い始める。返した `IDisposable` を捨てると基準も消える。
 *
 * 途中から追い始めた行（ウィンドウの再読み込みで繋ぎ直した直後など）は、すでに打たれた文字があるかもしれないので
 * 基準を持たない（右プロンプトの位置も分からなければ、次のプロンプトまで空と読まない）。
 */
export function paradisTrackPromptInputBaseline(source: IParadisPromptInputSource): IDisposable {
	const model = source.promptInputModel;
	const store = new DisposableStore();
	baselines.delete(source);
	store.add(model.onDidStartInput(() => baselines.set(source, PARADIS_PROMPT_BASELINE_START)));
	store.add(model.onDidChangeInput(state => {
		const previous = baselines.get(source);
		if (previous !== undefined) {
			baselines.set(source, paradisNextPromptBaseline(previous, state));
		}
	}));
	store.add(model.onDidFinishInput(() => baselines.delete(source)));
	store.add(toDisposable(() => baselines.delete(source)));
	return store;
}
