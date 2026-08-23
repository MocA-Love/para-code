/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「おやすみモード」セクション。有効化トグルと解除タイミングの select、
// 残り時間の hint を扱う（ステータスバーのクイックトグルと同じ選択肢を
// common/paradisDoNotDisturb.ts から共有する）。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisDoNotDisturbState, IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisCreateDoNotDisturbRefreshController, paradisFormatDoNotDisturbRemaining, PARADIS_DO_NOT_DISTURB_DURATIONS, ParadisDoNotDisturbRefreshControllerFactory } from '../common/paradisDoNotDisturb.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.dnd.section.title', "おやすみモード");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.dnd.section.desc', "オンの間はこのPCの通知音・デスクトップ通知・音声読み上げをすべて止めます（作業自体は止まりません）。");
// allow-any-unicode-next-line
const STR_TOGGLE_LABEL = localize('paradis.dnd.section.toggleLabel', "おやすみモード");
// allow-any-unicode-next-line
const STR_TOGGLE_HINT = localize('paradis.dnd.section.toggleHint', "このPCでの通知をすべて止めます。モバイルアプリへのPush通知は対象外です。");
// allow-any-unicode-next-line
const STR_DURATION_LABEL = localize('paradis.dnd.section.durationLabel', "解除するタイミング");
// allow-any-unicode-next-line
const STR_MANUAL_HINT = localize('paradis.dnd.section.manualHint', "自分でオフにするまで止め続けます。");

/** 選択肢の同定に使う許容差（ms）。resolveUntil の計算時刻が変更時刻とずれるため。 */
const DURATION_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

export class ParadisDoNotDisturbSection extends Disposable {

	protected static readonly refreshControllerFactory: ParadisDoNotDisturbRefreshControllerFactory
		= refresh => paradisCreateDoNotDisturbRefreshController(refresh);

	private readonly _renderDisposables = this._register(new DisposableStore());

	/**
	 * このダイアログで時限を選択した際の `{ until, id }`。経過に伴う再計算では
	 * resolveUntil の基準時刻がずれて許容差を超えるため、保存済み until が同一の間は
	 * 選択時の id を優先して select の表示を固定する。
	 */
	private _rememberedDurationSelection: { readonly until: number; readonly id: string } | undefined;

	constructor(
		private readonly container: HTMLElement,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) {
		super();

		const refreshControllerFactory = new.target.refreshControllerFactory;
		const refreshController = this._register(refreshControllerFactory(renderNow => this._refresh(renderNow)));
		this._register(this.settingsService.onDidChangeDoNotDisturb(() => refreshController.refresh()));
		refreshController.refresh();
	}

	private _refresh(renderNow: number): IParadisDoNotDisturbState {
		const state = this.settingsService.getDoNotDisturb();
		paradisPreserveScroll(this.container, () => this._renderBody(state, renderNow));
		return state;
	}

	private _renderBody(state: IParadisDoNotDisturbState, renderNow: number): void {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		dom.append(this.container, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(this.container, $('.pns-section-desc')).textContent = STR_DESC;

		const toggleRow = dom.append(this.container, $('.setting-row'));
		const toggleLabels = dom.append(toggleRow, $('.sr-main'));
		dom.append(toggleLabels, $('.sr-label')).textContent = STR_TOGGLE_LABEL;
		dom.append(toggleLabels, $('.sr-desc')).textContent = STR_TOGGLE_HINT;
		const toggle = dom.append(toggleRow, $('input.pns-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = state.enabled;
		this._renderDisposables.add(dom.addDisposableListener(toggle, 'change', () => {
			// トグルからオンにした場合は既定で「自分でオフにするまで」。期間はこの下の select で選ぶ。
			this.settingsService.setDoNotDisturb(toggle.checked, undefined);
		}));

		if (!state.enabled) {
			return;
		}

		const row = dom.append(this.container, $('.setting-row'));
		const labels = dom.append(row, $('.sr-main'));
		dom.append(labels, $('.sr-label')).textContent = STR_DURATION_LABEL;
		const remaining = paradisFormatDoNotDisturbRemaining(state.until, renderNow);
		dom.append(labels, $('.sr-desc')).textContent = remaining
			// allow-any-unicode-next-line
			? localize('paradis.dnd.section.remainingHint', "あと{0}で自動的に解除されます。", remaining)
			: STR_MANUAL_HINT;

		const select = dom.append(row, $('select.pns-select')) as HTMLSelectElement;
		select.style.width = '190px';
		for (const duration of PARADIS_DO_NOT_DISTURB_DURATIONS) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = duration.id;
			option.textContent = duration.label;
		}
		// select の選択状態は _matchDurationId で「自分でオフにするまで」を含む全ての選択肢に一律反映する
		// （until 未設定なら manual、時限3つは許容差内の一致で判定）。時限の残り時間は選択のたびに
		// 減っていくため、select 自体ではなく左の残り時間 hint で別途示す。
		select.value = this._matchDurationId(state.until, renderNow);
		this._renderDisposables.add(dom.addDisposableListener(select, 'change', () => {
			const duration = PARADIS_DO_NOT_DISTURB_DURATIONS.find(d => d.id === select.value);
			if (duration) {
				const until = duration.resolveUntil(Date.now());
				this._rememberedDurationSelection = until === undefined ? undefined : { until, id: duration.id };
				this.settingsService.setDoNotDisturb(true, until);
			}
		}));
	}

	/**
	 * 保存済みの解除予定時刻に対応する選択肢の id。一致しない場合は最初の時限選択肢にフォールバックする。
	 * ユーザーがこのダイアログで選択した時限は `_rememberedDurationSelection` の until と完全一致する間は
	 * その id を返す。resolveUntil を現在時刻で再計算すると経過のたびに差分が膨らみ
	 * （例:「1時間」選択から6分経過で許容差5分を超えて「30分」へフォールバック）、
	 * 60秒ごとの再描画で select 表示が勝手に切り替わって見えるため。
	 */
	private _matchDurationId(until: number | undefined, renderNow: number): string {
		if (until === undefined) {
			return 'manual';
		}
		if (this._rememberedDurationSelection?.until === until) {
			return this._rememberedDurationSelection.id;
		}
		for (const duration of PARADIS_DO_NOT_DISTURB_DURATIONS) {
			const resolved = duration.resolveUntil(renderNow);
			if (resolved !== undefined && Math.abs(resolved - until) <= DURATION_MATCH_TOLERANCE_MS) {
				return duration.id;
			}
		}
		return PARADIS_DO_NOT_DISTURB_DURATIONS[0].id;
	}
}
