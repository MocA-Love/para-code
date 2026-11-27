/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のテンプレートの M のモーダル（左に分類、右に一覧と詳細）。作成の S のモーダル（paradisBotCreateDialog.ts）の
// 上に入れ子の箱として開き、選んだテンプレートを S のモーダルへ返す（作るのは S のモーダル）。

import './media/paradisBotTemplates.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ParadisButton, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisCheck } from '../../../browser/paradisCheck.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisBotTemplate, PARADIS_BOT_TEMPLATE_CATALOG, PARADIS_BOT_TEMPLATE_CATEGORIES, paradisBotTemplate, ParadisBotTemplateCategory, paradisBotTemplateCategoryLabel, paradisBotTemplateSkillFile, paradisFilterBotTemplates } from '../common/paradisBotTemplates.js';

/** 一覧の「白紙の Bot」の行の id（テンプレートを外す）。 */
export const PARADIS_BOT_BLANK_TEMPLATE_ID = 'blank';

/** 選んだもの。`template` が undefined なら白紙。 */
export interface IParadisBotTemplatePick {
	readonly template: IParadisBotTemplate | undefined;
	/** 付属のスキルを入れるか。 */
	readonly withSkill: boolean;
}

export class ParadisBotTemplatesDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly categories: HTMLElement;
	private readonly list: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly search: ParadisInputField;
	private readonly submit: ParadisButton;
	private readonly categoryDisposables = this._register(new DisposableStore());
	private readonly listDisposables = this._register(new DisposableStore());
	private readonly detailDisposables = this._register(new DisposableStore());
	private category: ParadisBotTemplateCategory | 'all' = 'all';
	private selected: string;
	private withSkill = true;
	private rows: HTMLElement[] = [];

	constructor(
		restoreFocusTo: HTMLElement | undefined,
		initial: string | undefined,
		private readonly onDidPick: (pick: IParadisBotTemplatePick) => void,
		@ILayoutService layoutService: ILayoutService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this.selected = paradisBotTemplate(initial)?.id ?? PARADIS_BOT_TEMPLATE_CATALOG[0].id;

		// 作成のモーダルの上に重ねる入れ子の箱（作成のモーダルを閉じない）
		this.backdrop = dom.$(`.paradis-bot-templates-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}.paradis-modal-backdrop-nested`);
		const modal = dom.append(this.backdrop, dom.$('.paradis-bot-templates'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Medium));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');

		const head = renderParadisModalHead(modal, localize('paradis.bots.templates.title', "Bot のテンプレート"));
		head.title.id = 'paradis-bot-templates-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		const closeLabel = localize('paradis.bots.templates.close', "閉じる");
		const close = dom.append(head.actions, dom.$('button.pbtd-close')) as HTMLButtonElement;
		close.classList.add(...paradisButtonClasses('icon'));
		close.type = 'button';
		close.setAttribute('aria-label', closeLabel);
		this._register(hoverService.setupDelayedHover(close, { content: closeLabel }));
		dom.append(close, dom.$(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const body = dom.append(modal, dom.$(`.${PARADIS_MODAL_BODY_CLASS}.pbtd-body`));
		const searchLabel = localize('paradis.bots.templates.search', "テンプレートを検索");
		this.search = this._register(new ParadisInputField(body, { ariaLabel: searchLabel, placeholder: searchLabel, icon: Codicon.search, small: true }));
		this._register(this.search.onDidChange(() => this.renderList()));
		const columns = dom.append(body, dom.$('.pbtd-columns'));
		this.categories = dom.append(columns, dom.$('.pbtd-categories'));
		this.categories.setAttribute('role', 'group');
		this.categories.setAttribute('aria-label', localize('paradis.bots.templates.categories', "分類"));
		const right = dom.append(columns, dom.$('.pbtd-right'));
		this.list = dom.append(right, dom.$('.pbtd-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.setAttribute('aria-label', localize('paradis.bots.templates.list', "テンプレート"));
		this.detail = dom.append(right, dom.$('.pbtd-detail'));

		const foot = dom.append(modal, dom.$(`.${PARADIS_MODAL_FOOT_CLASS}`));
		dom.append(foot, dom.$('span.pbtd-grow'));
		const cancel = this._register(new ParadisButton(foot, { kind: 'secondary', label: localize('paradis.bots.templates.cancel', "やめる") }));
		this._register(cancel.onDidClick(() => this.dispose()));
		this.submit = this._register(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.bots.templates.use', "このテンプレートで作る...") }));
		this._register(this.submit.onDidClick(() => this.pick()));

		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, event => {
			if (event.target === this.backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal,
			nested: true,
			onEscape: () => this.dispose(),
			close: () => this.dispose(),
			restoreFallback: () => restoreFocusTo?.isConnected ? restoreFocusTo : undefined,
		}));
		this.renderCategories();
		this.renderList();
		this.search.focus();
	}

	private renderCategories(): void {
		this.categoryDisposables.clear();
		dom.clearNode(this.categories);
		for (const category of ['all' as const, ...PARADIS_BOT_TEMPLATE_CATEGORIES]) {
			const button = dom.append(this.categories, dom.$('button.pbtd-category.paradis-focus-ring-inset')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = paradisBotTemplateCategoryLabel(category, PARADIS_BOT_TEMPLATE_CATALOG.length);
			button.setAttribute('aria-pressed', String(this.category === category));
			this.categoryDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this.category = category;
				this.renderCategories();
				this.renderList();
			}));
		}
	}

	private renderList(): void {
		this.listDisposables.clear();
		dom.clearNode(this.list);
		const templates = paradisFilterBotTemplates(this.category, this.search.value);
		const entries: { readonly id: string; readonly name: string; readonly line: string }[] = templates.map(template => ({ id: template.id, name: template.name, line: template.role }));
		// 白紙は「すべて」の最後に 1 行（探しているときは出さない）
		if (this.category === 'all' && this.search.value.trim().length === 0) {
			entries.push({ id: PARADIS_BOT_BLANK_TEMPLATE_ID, name: localize('paradis.bots.templates.blank', "白紙の Bot"), line: localize('paradis.bots.templates.blankLine', "名前と役割だけ決めて始める") });
		}
		if (entries.length === 0) {
			dom.append(this.list, dom.$('.pbtd-empty')).textContent = localize('paradis.bots.templates.none', "合うテンプレートはありません");
		}
		if (!entries.some(entry => entry.id === this.selected) && entries.length > 0) {
			this.selected = entries[0].id;
		}
		this.rows = entries.map(entry => {
			const row = dom.append(this.list, dom.$('.pbtd-row.paradis-focus-ring-inset'));
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(entry.id === this.selected));
			row.tabIndex = entry.id === this.selected ? 0 : -1;
			row.dataset.templateId = entry.id;
			dom.append(row, dom.$('span.pbtd-row-name')).textContent = entry.name;
			const line = dom.append(row, dom.$('span.pbtd-row-line'));
			line.textContent = entry.line;
			line.title = entry.line;
			this.listDisposables.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.select(entry.id)));
			this.listDisposables.add(dom.addDisposableListener(row, dom.EventType.DBLCLICK, () => this.pick()));
			this.listDisposables.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);
				const index = this.rows.indexOf(row);
				if (event.equals(KeyCode.Enter)) {
					dom.EventHelper.stop(e, true);
					this.pick();
				} else if (event.equals(KeyCode.DownArrow) || event.equals(KeyCode.UpArrow)) {
					dom.EventHelper.stop(e, true);
					const next = this.rows[Math.max(0, Math.min(this.rows.length - 1, index + (event.equals(KeyCode.DownArrow) ? 1 : -1)))];
					this.select(next.dataset.templateId!);
					next.focus();
				}
			}));
			return row;
		});
		this.renderDetail();
	}

	private select(id: string): void {
		this.selected = id;
		for (const row of this.rows) {
			const on = row.dataset.templateId === id;
			row.setAttribute('aria-selected', String(on));
			row.tabIndex = on ? 0 : -1;
		}
		this.renderDetail();
	}

	private renderDetail(): void {
		this.detailDisposables.clear();
		dom.clearNode(this.detail);
		const template = paradisBotTemplate(this.selected);
		this.submit.enabled = this.rows.length > 0;
		if (template === undefined) {
			dom.append(this.detail, dom.$('.pbtd-detail-text')).textContent = localize('paradis.bots.templates.blankDetail', "名前と役割だけを決めて始めます。人格メモ（SOUL.md）は空の雛形で作ります。");
			return;
		}
		dom.append(this.detail, dom.$('.pbtd-detail-title')).textContent = template.name;
		const kv = dom.append(this.detail, dom.$('.pbtd-kv'));
		for (const [label, value] of [
			[localize('paradis.bots.templates.watches', "見るもの"), template.watches],
			[localize('paradis.bots.templates.does', "すること"), template.does],
			[localize('paradis.bots.templates.reports', "知らせること"), template.reports],
			[localize('paradis.bots.templates.firstChat', "最初の会話で"), template.firstChat],
		]) {
			dom.append(kv, dom.$('span.pbtd-key')).textContent = label;
			dom.append(kv, dom.$('span.pbtd-value')).textContent = value;
		}
		dom.append(this.detail, dom.$('.pbtd-comes-title')).textContent = localize('paradis.bots.templates.comesWith', "付いてくるもの");
		if (template.skill !== undefined) {
			const skill = this.detailDisposables.add(new ParadisCheck(this.detail, { label: localize('paradis.bots.templates.skill', "スキル {0}", template.skill.name), checked: this.withSkill }));
			skill.element.classList.add('pbtd-skill');
			this.detailDisposables.add(skill.onDidChange(checked => this.withSkill = checked));
			dom.append(this.detail, dom.$('.pbtd-note')).textContent = localize('paradis.bots.templates.skillNote', "Bot の専用フォルダに置きます。チェックを外すと入れません");
			// 置く中身（SKILL.md）を作る前に読めるように
			const details = dom.append(this.detail, dom.$('details.pbtd-skill-body'));
			dom.append(details, dom.$('summary')).textContent = localize('paradis.bots.templates.skillBody', "スキルの中身を見る");
			dom.append(details, dom.$('pre')).textContent = paradisBotTemplateSkillFile(template.skill);
		}
		if (template.note !== undefined) {
			dom.append(this.detail, dom.$('.pbtd-note')).textContent = template.note;
		}
	}

	private pick(): void {
		if (this.rows.length === 0) {
			return;
		}
		const template = paradisBotTemplate(this.selected);
		const pick: IParadisBotTemplatePick = { template, withSkill: template?.skill !== undefined && this.withSkill };
		this.dispose();
		this.onDidPick(pick);
	}

	override dispose(): void {
		this.backdrop.remove();
		super.dispose();
	}
}
