/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセットの実行の前の確認（Q613）。UI キットの S の箱（paradisModal.ts）で組む。
//
// - 既定のボタンは「やめる」で、最初のフォーカスもそこ（名前を打つ段では入力欄）。Enter は、フォーカスが「実行」に
//   あるときだけ実行し、それ以外（入力欄・やめる・本文）では「やめる」になる
// - 名前を打つ段は、打った名前がプリセットの名前と一致するまで「実行」を押せない
// - まとめて実行は、確認付きのものを 1 回の確認に並べる（名前を打つ段のものが複数あれば、それぞれの名前を打たせる）

import './media/paradisPresetRunConfirm.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { ParadisPresetConfirmLevel } from '../common/paradisTerminalPresets.js';

const $ = dom.$;

const STR_CANCEL = localize('paradis.presetConfirm.cancel', "やめる");
const STR_RUN = localize('paradis.presetConfirm.run', "実行");
const STR_CLOSE = localize('paradis.presetConfirm.close', "閉じる");
const STR_SIMPLE = localize('paradis.presetConfirm.simple', "コマンドプリセットを実行します。");
const STR_DETAILS = localize('paradis.presetConfirm.details', "次の内容で実行します。");
const STR_HOST = localize('paradis.presetConfirm.host', "接続先");
const STR_REPOSITORY = localize('paradis.presetConfirm.repository', "対象");
const STR_ACTIVE_TERMINAL = localize('paradis.presetConfirm.activeTerminal', "今のターミナル");
const strTitleOne = (name: string) => localize('paradis.presetConfirm.titleOne', "「{0}」を実行しますか？", name);
const strTitleMany = (count: number) => localize('paradis.presetConfirm.titleMany', "{0} 件のプリセットを実行しますか？", count);
const strTypeName = (name: string) => localize('paradis.presetConfirm.typeName', "確かめるため、プリセットの名前「{0}」を打ってください", name);
const strOthers = (count: number) => localize('paradis.presetConfirm.others', "ほかに、確認の要らない {0} 件も一緒に実行します。", count);

/** 確認の画面に出す 1 件。作業フォルダ・接続先・対象はプリセットのサービスが実行と同じ決め方で解いて渡す。 */
export interface IParadisPresetRunConfirmEntry {
	readonly name: string;
	readonly level: ParadisPresetConfirmLevel;
	/** SSH の接続先（接続していなければ「このマシン」）。 */
	readonly host: string;
	/** 対象のリポジトリ（作業フォルダの基準）。分からなければ省く。 */
	readonly repository?: string;
	readonly terminals: readonly IParadisPresetRunConfirmTerminal[];
}

export interface IParadisPresetRunConfirmTerminal {
	readonly name: string;
	/** 作業フォルダ。省くと今のターミナル（並べ方が「今のターミナル」で、作業フォルダの指定が無いとき）。 */
	readonly cwd?: string;
	readonly commands: readonly string[];
}

/** 名前を打つ段で、打った文字が名前と一致しているか（前後の空白は見ない）。 */
export function paradisPresetTypedNameMatches(typed: string, name: string): boolean {
	return typed.trim() === name.trim();
}

/**
 * 確認の画面を開き、「実行」が押されたら true、やめたら false で終わる。
 * `others` は、まとめて実行で一緒に走る確認の要らないものの件数（本文で知らせる）。`note` は本文の最後に添える一言。
 */
export function paradisShowPresetRunConfirm(container: HTMLElement, entries: readonly IParadisPresetRunConfirmEntry[], others = 0, note?: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const store = new DisposableStore();
		// fork のモーダル（プリセットの画面など）の中から開くときは入れ子の段に置き、下の箱を閉じない
		const nested = ParadisModalFocus.isModalOpenIn(container);
		const backdrop = $(`.paradis-preset-confirm-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		backdrop.classList.toggle('paradis-modal-backdrop-nested', nested);
		const modal = dom.append(backdrop, $('.paradis-preset-confirm'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'alertdialog');
		modal.setAttribute('aria-modal', 'true');

		let settled = false;
		const finish = (run: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			store.dispose();
			backdrop.remove();
			resolve(run);
		};

		const head = renderParadisModalHead(modal, entries.length === 1 ? strTitleOne(entries[0].name) : strTitleMany(entries.length + others));
		head.title.id = 'paradis-preset-confirm-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		const close = dom.append(head.actions, $<HTMLButtonElement>('button'));
		close.type = 'button';
		close.classList.add(...paradisButtonClasses('icon'));
		close.title = STR_CLOSE;
		close.setAttribute('aria-label', STR_CLOSE);
		dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		store.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => finish(false)));

		const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}.ppc-body`));
		const nameChecks: { readonly input: ParadisInputField; readonly name: string }[] = [];
		for (const entry of entries) {
			const section = dom.append(body, $('.ppc-entry'));
			if (entries.length > 1) {
				dom.append(section, $('.ppc-entry-name')).textContent = entry.name;
			}
			if (entry.level === 'confirm') {
				dom.append(section, $('.ppc-lead')).textContent = STR_SIMPLE;
				continue;
			}
			dom.append(section, $('.ppc-lead')).textContent = STR_DETAILS;
			const meta = dom.append(section, $('dl.ppc-meta'));
			dom.append(meta, $('dt')).textContent = STR_HOST;
			dom.append(meta, $('dd')).textContent = entry.host;
			if (entry.repository) {
				dom.append(meta, $('dt')).textContent = STR_REPOSITORY;
				dom.append(meta, $('dd')).textContent = entry.repository;
			}
			for (const terminal of entry.terminals) {
				const card = dom.append(section, $('.ppc-task'));
				const taskHead = dom.append(card, $('.ppc-task-head'));
				dom.append(taskHead, $(ThemeIcon.asCSSSelector(Codicon.terminal))).setAttribute('aria-hidden', 'true');
				dom.append(taskHead, $('span.ppc-task-name')).textContent = terminal.name;
				const cwd = dom.append(taskHead, $('span.ppc-task-cwd'));
				// 末尾だけ違うフォルダ（api と api-prod など）を見分けられるよう、切らずに折り返して全部出す
				cwd.textContent = terminal.cwd ?? STR_ACTIVE_TERMINAL;
				dom.append(card, $('pre.ppc-commands')).textContent = terminal.commands.join('\n');
			}
			if (entry.level === 'type-name') {
				const label = dom.append(section, $('label.ppc-type-label'));
				label.textContent = strTypeName(entry.name);
				const input = store.add(new ParadisInputField(section, { ariaLabel: strTypeName(entry.name) }));
				input.inputElement.autocomplete = 'off';
				nameChecks.push({ input, name: entry.name });
			}
		}
		if (others > 0) {
			dom.append(body, $('.ppc-lead.ppc-others')).textContent = strOthers(others);
		}
		if (note) {
			dom.append(body, $('.ppc-lead')).textContent = note;
		}

		const foot = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
		const cancel = dom.append(foot, $<HTMLButtonElement>('button'));
		cancel.type = 'button';
		cancel.classList.add(...paradisButtonClasses('secondary'));
		cancel.textContent = STR_CANCEL;
		const run = dom.append(foot, $<HTMLButtonElement>('button'));
		run.type = 'button';
		run.classList.add(...paradisButtonClasses('danger'));
		run.textContent = STR_RUN;
		const canRun = () => nameChecks.every(check => paradisPresetTypedNameMatches(check.input.value, check.name));
		const updateRun = () => {
			// キットのボタンは `.disabled` で押せない見た目になる（paradisButton.css）
			run.disabled = !canRun();
			run.classList.toggle('disabled', run.disabled);
		};
		updateRun();
		for (const check of nameChecks) {
			store.add(check.input.onDidChange(updateRun));
		}
		store.add(dom.addDisposableListener(cancel, dom.EventType.CLICK, () => finish(false)));
		store.add(dom.addDisposableListener(run, dom.EventType.CLICK, () => {
			if (canRun()) {
				finish(true);
			}
		}));
		store.add(dom.addDisposableListener(backdrop, dom.EventType.MOUSE_DOWN, e => {
			if (e.target === backdrop) {
				finish(false);
			}
		}));
		// Enter は「実行」にフォーカスがあるときだけ実行する。ほか（入力欄・やめる・本文）では「やめる」にする
		store.add(dom.addDisposableListener(backdrop, dom.EventType.KEY_DOWN, e => {
			if (e.key !== 'Enter' || e.isComposing) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const focused = dom.getActiveElement();
			if (focused === run && canRun()) {
				finish(true);
			} else {
				finish(false);
			}
		}));

		container.appendChild(backdrop);
		store.add(new ParadisModalFocus({ backdrop, modal, nested, onEscape: () => finish(false), close: () => finish(false) }));
		(nameChecks[0]?.input ?? cancel).focus();
	});
}
