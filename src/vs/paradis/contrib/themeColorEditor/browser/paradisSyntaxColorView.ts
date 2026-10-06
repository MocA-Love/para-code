/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// テーマの色エディタの「シンタックスの色」タブ。
//   - よく使うグループ（editor.tokenColorCustomizations の comments / strings / …）
//   - TextMate のスコープ（同じ設定の textMateRules。今のテーマのスコープの中のものだけを編集する）
//   - セマンティック（editor.semanticTokenColorCustomizations の rules）
// 右にはピッカー・斜体/太字と、実物のエディタで色付けしたコードのプレビューを置く。プレビューの文字を
// クリックすると、その文字の TextMate スコープ（Inspect Editor Tokens と同じ取り方）から編集する対象を選ぶ。
// textMateRules は配列でメモリ層の深いマージが効かないため、下書きでは配列を丸ごと持って書く。

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { getTokenClassificationRegistry, TokenStyle } from '../../../../platform/theme/common/tokenClassificationRegistry.js';
import { ColorThemeData } from '../../../../workbench/services/themes/common/colorThemeData.js';
import { ITextMateTokenizationService } from '../../../../workbench/services/textMate/browser/textMateTokenizationFeature.js';
import { IWorkbenchThemeService } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import {
	IParadisJsonObject,
	IParadisTextMateRule,
	IParadisTokenStyle,
	paradisHasFontStyle,
	paradisIsPlainObject,
	paradisMatchSyntaxTarget,
	paradisReadSemanticStyle,
	paradisReadTextMateRules,
	paradisReadTokenStyle,
	paradisThemeSpecificValues,
	paradisToggleFontStyle,
	paradisTokenStyleToGroupValue,
	paradisTokenStyleToSemanticValue,
	ParadisFontStyleFlag,
	ParadisTokenGroup,
	PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
	PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY,
	PARADIS_TOKEN_GROUP_PROBE,
	PARADIS_TOKEN_GROUPS,
} from '../common/paradisThemeColorModel.js';
import { ParadisColorPickerWidget } from './paradisColorPickerWidget.js';
import { IParadisThemeColorDraftService } from './paradisThemeColorDraftService.js';
import { IParadisLayerRow, paradisCreateButton, paradisCreateChip, paradisRenderLayerRows, paradisSetSwatch } from './paradisThemeColorViewParts.js';

const $ = dom.$;

type Target =
	| { readonly kind: 'group'; readonly group: ParadisTokenGroup }
	| { readonly kind: 'rule'; readonly index: number }
	| { readonly kind: 'semantic'; readonly type: string };

type PreviewLanguage = 'typescript' | 'python' | 'json';

function groupLabel(group: ParadisTokenGroup): string {
	switch (group) {
		case 'comments': return localize('paradis.themeColors.token.comments', "コメント");
		case 'strings': return localize('paradis.themeColors.token.strings', "文字列");
		case 'keywords': return localize('paradis.themeColors.token.keywords', "キーワード");
		case 'numbers': return localize('paradis.themeColors.token.numbers', "数値");
		case 'types': return localize('paradis.themeColors.token.types', "型");
		case 'functions': return localize('paradis.themeColors.token.functions', "関数");
		case 'variables': return localize('paradis.themeColors.token.variables', "変数");
	}
}

const PREVIEW_SAMPLES: { readonly [L in PreviewLanguage]: { readonly label: string; readonly text: string } } = {
	typescript: {
		label: 'TypeScript',
		text: [
			'// Returns the total of the values',
			'export function sum(values: number[]): number {',
			'\treturn values.reduce((total, value) => total + value, 0);',
			'}',
			'',
			'class Counter {',
			'\tprivate count = 0;',
			'\tincrement(): void { this.count++; }',
			'}',
			'const label = `total: ${sum([1, 2, 3])}`;',
		].join('\n'),
	},
	python: {
		label: 'Python',
		text: [
			'# Returns the total of the values',
			'def total(values: list[int]) -> int:',
			'    return sum(values)',
			'',
			'class Counter:',
			'    def __init__(self):',
			'        self.count = 0',
			'',
			'label = f"total: {total([1, 2, 3])}"',
		].join('\n'),
	},
	json: {
		label: 'JSON',
		text: [
			'{',
			'\t"name": "para-code",',
			'\t"version": 1,',
			'\t"private": true,',
			'\t"tags": ["editor", null]',
			'}',
		].join('\n'),
	},
};

const PREVIEW_OPTIONS: IEditorConstructionOptions = {
	automaticLayout: true,
	readOnly: true,
	domReadOnly: true,
	minimap: { enabled: false },
	lineNumbers: 'off',
	glyphMargin: false,
	folding: false,
	scrollBeyondLastLine: false,
	renderLineHighlight: 'none',
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	contextmenu: false,
	stickyScroll: { enabled: false },
	guides: { indentation: false },
	scrollbar: { alwaysConsumeMouseWheel: false },
};

let previewModelCounter = 0;

/** 一覧の 1 行と、最後に描いた色見本・バッジ（変わったときだけ DOM を書き換えるため）。 */
interface ISyntaxRow {
	readonly target: Target;
	readonly row: HTMLElement;
	readonly swatch: HTMLElement;
	readonly badge: HTMLElement;
	swatchValue: string | undefined;
	badgeKey: string | undefined;
}

function tokenStyleHex(style: TokenStyle | undefined): string | undefined {
	return style?.foreground ? Color.Format.CSS.formatHexA(style.foreground, true).toUpperCase() : undefined;
}

function tokenStyleFontStyle(style: TokenStyle | undefined): string | undefined {
	if (!style) {
		return undefined;
	}
	const words = (['italic', 'bold', 'underline', 'strikethrough'] as const).filter(flag => style[flag]);
	return words.length ? words.join(' ') : undefined;
}

function cloneObject(value: IParadisJsonObject): IParadisJsonObject {
	return JSON.parse(JSON.stringify(value));
}

export class ParadisSyntaxColorView extends Disposable {

	readonly element: HTMLElement;

	private readonly searchInput: HTMLInputElement;
	private readonly items: HTMLElement;
	private readonly rows: ISyntaxRow[] = [];
	private renderedShape: string | undefined;
	private readonly listStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly searchScheduler = this._register(new RunOnceScheduler(() => this.renderList(), 120));

	private readonly detailTitle: HTMLElement;
	private readonly detailDescription: HTMLElement;
	private readonly detailNote: HTMLElement;
	private readonly scopeInput: HTMLInputElement;
	private readonly picker: ParadisColorPickerWidget;
	private readonly toggleButtons = new Map<ParadisFontStyleFlag, HTMLButtonElement>();
	private readonly layers: HTMLElement;
	private readonly clearButton: Button;
	private readonly languageButtons = new Map<PreviewLanguage, HTMLButtonElement>();
	private readonly previewContainer: HTMLElement;
	private readonly previewInfo: HTMLElement;
	private readonly previewInfoStore = this._register(new MutableDisposable<DisposableStore>());

	private target: Target = { kind: 'group', group: 'keywords' };
	private language: PreviewLanguage = 'typescript';
	private previewEditor: CodeEditorWidget | undefined;
	private readonly previewModel = this._register(new MutableDisposable());
	private previewHit: IEditorDecorationsCollection | undefined;
	private shown = false;

	constructor(
		container: HTMLElement,
		@IParadisThemeColorDraftService private readonly draftService: IParadisThemeColorDraftService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ITextMateTokenizationService private readonly textMateService: ITextMateTokenizationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.element = dom.append(container, $('.paradis-tce-view.paradis-tce-syntax'));
		const store = this._register(new DisposableStore());

		// --- 左: 一覧 ---
		const list = dom.append(this.element, $('.paradis-tce-list'));
		const searchRow = dom.append(list, $('.paradis-tce-search-row'));
		this.searchInput = dom.append(searchRow, $<HTMLInputElement>('input.paradis-tce-input.paradis-tce-search', {
			type: 'search',
			placeholder: localize('paradis.themeColors.syntax.search', "トークンを検索（例: コメント、keyword）"),
			'aria-label': localize('paradis.themeColors.syntax.searchAria', "トークンを検索"),
		}));
		store.add(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => this.searchScheduler.schedule()));
		this.items = dom.append(list, $('.paradis-tce-items', { role: 'listbox', 'aria-label': localize('paradis.themeColors.syntax.listAria', "シンタックスの色の一覧") }));
		store.add(dom.addDisposableListener(this.items, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => this.onListKey(e)));

		// --- 右: 詳細 ---
		const detail = dom.append(this.element, $('.paradis-tce-detail'));
		this.detailTitle = dom.append(detail, $('.paradis-tce-detail-id'));
		this.detailDescription = dom.append(detail, $('.paradis-tce-detail-desc'));
		this.detailNote = dom.append(detail, $('.paradis-tce-detail-warning'));
		this.scopeInput = dom.append(detail, $<HTMLInputElement>('input.paradis-tce-input.paradis-tce-scope-input', {
			type: 'text',
			spellcheck: 'false',
			'aria-label': localize('paradis.themeColors.syntax.scopeAria', "TextMate のスコープ"),
		}));
		store.add(dom.addDisposableListener(this.scopeInput, dom.EventType.CHANGE, () => this.renameRuleScope(this.scopeInput.value)));
		this.picker = this._register(new ParadisColorPickerWidget(detail));
		this._register(this.draftService.registerFlushParticipant(() => this.picker.flush()));
		this._register(this.picker.onDidChange(color => {
			const style = this.readStyle(this.target);
			this.writeStyle(this.target, { ...style, foreground: Color.Format.CSS.formatHexA(color, true).toUpperCase() });
		}));
		const toggles = dom.append(detail, $('.paradis-tce-toggles'));
		const flags: [ParadisFontStyleFlag, string][] = [
			['italic', localize('paradis.themeColors.syntax.italic', "斜体")],
			['bold', localize('paradis.themeColors.syntax.bold', "太字")],
			['underline', localize('paradis.themeColors.syntax.underline', "下線")],
			['strikethrough', localize('paradis.themeColors.syntax.strikethrough', "取り消し線")],
		];
		for (const [flag, label] of flags) {
			const chip = paradisCreateChip(toggles, label, store, () => this.toggleFontStyle(flag));
			chip.classList.add(flag);
			chip.setAttribute('aria-pressed', 'false');
			this.toggleButtons.set(flag, chip);
		}
		this.layers = dom.append(detail, $('.paradis-tce-layers'));
		const actions = dom.append(detail, $('.paradis-tce-actions'));
		this.clearButton = paradisCreateButton(actions, '', store, () => this.clearTarget());

		const previewHead = dom.append(detail, $('.paradis-tce-preview-head'));
		dom.append(previewHead, $('span', undefined, localize('paradis.themeColors.syntax.previewTitle', "プレビュー（文字をクリックすると、その色を選びます）")));
		for (const language of Object.keys(PREVIEW_SAMPLES) as PreviewLanguage[]) {
			this.languageButtons.set(language, paradisCreateChip(previewHead, PREVIEW_SAMPLES[language].label, store, () => {
				this.language = language;
				this.renderPreview();
			}));
		}
		this.previewContainer = dom.append(detail, $('.paradis-tce-preview'));
		this.previewInfo = dom.append(detail, $('.paradis-tce-preview-info'));

		this._register(this.draftService.onDidChange(() => this.refresh()));
		this._register(this.draftService.onDidChangeLayers(() => this.refresh()));
		let lastThemeId = this.themeService.getColorTheme().id;
		this._register(this.themeService.onDidColorThemeChange(theme => {
			if (theme.id !== lastThemeId) {
				lastThemeId = theme.id;
				this.target = { kind: 'group', group: 'keywords' };
				this.renderList();
				this.renderDetail(true);
			} else {
				this.refreshSwatches();
			}
		}));
	}

	/** タブを初めて開いたときに中身を作る（プレビューのエディタはこのとき初めて作る）。 */
	show(): void {
		if (!this.shown) {
			this.shown = true;
			this.renderList();
			this.renderDetail(true);
			this.renderPreview();
		}
	}

	layout(): void {
		this.previewEditor?.layout();
	}

	focus(): void {
		this.searchInput.focus();
	}

	private get settingsId(): string {
		return this.themeService.getColorTheme().settingsId;
	}

	// --- 下書きの読み書き ---

	private tokenDraft(): IParadisJsonObject {
		return this.draftService.getScopedDraft('token', this.settingsId);
	}

	private semanticDraft(): IParadisJsonObject {
		return this.draftService.getScopedDraft('semantic', this.settingsId);
	}

	/** textMateRules の生の配列（読めない要素も位置を保つため、そのまま持つ）。 */
	private rawRules(): unknown[] {
		const rules = this.tokenDraft().textMateRules;
		return Array.isArray(rules) ? rules : [];
	}

	/** 位置をそろえた規則の一覧（読めない要素は scope が空の規則になり、何にも当たらない）。 */
	private alignedRules(): IParadisTextMateRule[] {
		return this.rawRules().map(rule => paradisReadTextMateRules([rule])[0] ?? { scope: '', settings: {} });
	}

	private semanticRules(): IParadisJsonObject {
		const rules = this.semanticDraft().rules;
		return paradisIsPlainObject(rules) ? rules : {};
	}

	private readStyle(target: Target): IParadisTokenStyle | undefined {
		switch (target.kind) {
			case 'group': return paradisReadTokenStyle(this.tokenDraft()[target.group]);
			case 'rule': {
				const rule = this.alignedRules()[target.index];
				return rule && (rule.settings.foreground !== undefined || rule.settings.fontStyle !== undefined) ? rule.settings : undefined;
			}
			case 'semantic': return paradisReadSemanticStyle(this.semanticRules()[target.type]);
		}
	}

	private readSavedStyle(target: Target): IParadisTokenStyle | undefined {
		const tokenOriginal = this.draftService.getScopedOriginal('token', this.settingsId);
		switch (target.kind) {
			case 'group': return paradisReadTokenStyle(tokenOriginal[target.group]);
			case 'rule': return undefined;
			case 'semantic': {
				const rules = this.draftService.getScopedOriginal('semantic', this.settingsId).rules;
				return paradisReadSemanticStyle(paradisIsPlainObject(rules) ? rules[target.type] : undefined);
			}
		}
	}

	private writeStyle(target: Target, style: IParadisTokenStyle | undefined): void {
		const settingsId = this.settingsId;
		switch (target.kind) {
			case 'group': {
				const next = cloneObject(this.tokenDraft());
				const value = paradisTokenStyleToGroupValue(style);
				if (value === undefined) {
					delete next[target.group];
				} else {
					next[target.group] = value;
				}
				this.draftService.setScopedDraft('token', settingsId, next);
				break;
			}
			case 'rule': {
				const next = cloneObject(this.tokenDraft());
				const rules = Array.isArray(next.textMateRules) ? next.textMateRules : [];
				const raw = paradisIsPlainObject(rules[target.index]) ? rules[target.index] as IParadisJsonObject : {};
				const settings: IParadisJsonObject = paradisIsPlainObject(raw.settings) ? { ...raw.settings } : {};
				delete settings.foreground;
				delete settings.fontStyle;
				if (style?.foreground !== undefined) {
					settings.foreground = style.foreground;
				}
				if (style?.fontStyle !== undefined) {
					settings.fontStyle = style.fontStyle;
				}
				rules[target.index] = { ...raw, scope: raw.scope ?? '', settings };
				next.textMateRules = rules;
				this.draftService.setScopedDraft('token', settingsId, next);
				break;
			}
			case 'semantic': {
				const next = cloneObject(this.semanticDraft());
				const rules: IParadisJsonObject = paradisIsPlainObject(next.rules) ? next.rules : {};
				const value = paradisTokenStyleToSemanticValue(style);
				if (value === undefined) {
					delete rules[target.type];
				} else {
					rules[target.type] = value;
				}
				if (Object.keys(rules).length) {
					next.rules = rules;
				} else {
					delete next.rules;
				}
				this.draftService.setScopedDraft('semantic', settingsId, next);
				break;
			}
		}
	}

	private toggleFontStyle(flag: ParadisFontStyleFlag): void {
		const style = this.readStyle(this.target) ?? {};
		const effective = style.fontStyle ?? this.themeStyle(this.target, false).fontStyle;
		const on = !paradisHasFontStyle(effective, flag);
		this.writeStyle(this.target, { ...style, fontStyle: paradisToggleFontStyle(effective, flag, on) });
		this.renderDetail(false);
	}

	private clearTarget(): void {
		const target = this.target;
		if (target.kind === 'rule') {
			const next = cloneObject(this.tokenDraft());
			const rules = Array.isArray(next.textMateRules) ? next.textMateRules : [];
			rules.splice(target.index, 1);
			if (rules.length) {
				next.textMateRules = rules;
			} else {
				delete next.textMateRules;
			}
			this.draftService.setScopedDraft('token', this.settingsId, next);
			this.target = { kind: 'group', group: 'keywords' };
		} else {
			this.writeStyle(target, undefined);
		}
		this.renderList();
		this.renderDetail(true);
	}

	private async addRule(initialScope?: string): Promise<void> {
		const scope = initialScope ?? await this.quickInputService.input({
			prompt: localize('paradis.themeColors.syntax.addPrompt', "色を変える TextMate のスコープ（例: keyword.control、string.quoted.double）"),
			placeHolder: 'keyword.control',
			validateInput: async value => value.trim() ? undefined : localize('paradis.themeColors.syntax.addEmpty', "スコープを入れてください"),
		});
		if (!scope?.trim()) {
			return;
		}
		const next = cloneObject(this.tokenDraft());
		const rules = Array.isArray(next.textMateRules) ? next.textMateRules : [];
		rules.push({ scope: scope.trim(), settings: {} });
		next.textMateRules = rules;
		this.draftService.setScopedDraft('token', this.settingsId, next);
		this.select({ kind: 'rule', index: rules.length - 1 });
	}

	private renameRuleScope(scope: string): void {
		const target = this.target;
		if (target.kind !== 'rule' || !scope.trim()) {
			return;
		}
		const next = cloneObject(this.tokenDraft());
		const rules = Array.isArray(next.textMateRules) ? next.textMateRules : [];
		const raw = paradisIsPlainObject(rules[target.index]) ? rules[target.index] as IParadisJsonObject : { settings: {} };
		rules[target.index] = { ...raw, scope: scope.trim() };
		next.textMateRules = rules;
		this.draftService.setScopedDraft('token', this.settingsId, next);
		this.renderList();
	}

	// --- テーマの値 ---

	/** テーマの色と字形。live=true なら設定の上書き（とプレビュー）込みの、いま画面に出ている値。 */
	private themeStyle(target: Target, live: boolean): IParadisTokenStyle {
		const current = this.themeService.getColorTheme();
		const theme = live ? (current instanceof ColorThemeData ? current : undefined) : this.draftService.getThemeSnapshot();
		if (!theme) {
			return {};
		}
		let style: TokenStyle | undefined;
		switch (target.kind) {
			case 'group':
				style = theme.resolveScopes([[PARADIS_TOKEN_GROUP_PROBE[target.group]]]);
				break;
			case 'rule': {
				const scope = this.alignedRules()[target.index]?.scope.split(',')[0]?.trim();
				style = scope ? theme.resolveScopes([scope.split(/\s+/)]) : undefined;
				break;
			}
			case 'semantic':
				style = theme.resolveTokenStyleValue(target.type);
				break;
		}
		return { foreground: tokenStyleHex(style), fontStyle: tokenStyleFontStyle(style) };
	}

	/** ワークスペースの設定が、今のテーマ向けにこの対象を書いているか（保存後もそちらが勝つ）。 */
	private workspaceDefines(target: Target): boolean {
		const key = target.kind === 'semantic' ? PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY : PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY;
		const scoped = paradisThemeSpecificValues(this.draftService.getLayers(key).workspace, this.settingsId);
		switch (target.kind) {
			case 'group': return scoped?.[target.group] !== undefined;
			case 'rule': return Array.isArray(scoped?.textMateRules);
			case 'semantic': {
				const rules = scoped?.rules;
				return paradisIsPlainObject(rules) && rules[target.type] !== undefined;
			}
		}
	}

	/** Para Code の既定（設定の default 層）の、今のテーマ向けの値。 */
	private paraDefaultStyle(target: Target): IParadisTokenStyle | undefined {
		if (target.kind === 'rule') {
			return undefined;
		}
		const key = target.kind === 'group' ? PARADIS_TOKEN_COLOR_CUSTOMIZATIONS_KEY : PARADIS_SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS_KEY;
		const layer = this.draftService.getLayers(key).paraDefault;
		const scoped = paradisThemeSpecificValues(layer, this.settingsId);
		if (target.kind === 'group') {
			return paradisReadTokenStyle(scoped?.[target.group] ?? (paradisIsPlainObject(layer) ? layer[target.group] : undefined));
		}
		const rules = scoped?.rules ?? (paradisIsPlainObject(layer) ? layer.rules : undefined);
		return paradisReadSemanticStyle(paradisIsPlainObject(rules) ? rules[target.type] : undefined);
	}

	// --- 描画 ---

	private targetLabel(target: Target): string {
		switch (target.kind) {
			case 'group': return groupLabel(target.group);
			case 'rule': return this.alignedRules()[target.index]?.scope || localize('paradis.themeColors.syntax.ruleUnnamed', "（スコープなし）");
			case 'semantic': return target.type;
		}
	}

	private sameTarget(a: Target, b: Target): boolean {
		return a.kind === b.kind && (a.kind === 'group' ? a.group === (b as typeof a).group : a.kind === 'rule' ? a.index === (b as typeof a).index : a.type === (b as typeof a).type);
	}

	/** 一覧の形（並ぶ規則）。これが変わったときだけ一覧を作り直し、それ以外は行の中身だけ描き直す。 */
	private listShape(): string {
		return JSON.stringify([this.searchInput.value, this.alignedRules().map(rule => rule.scope)]);
	}

	private renderList(): void {
		if (!this.shown) {
			return;
		}
		const store = new DisposableStore();
		this.listStore.value = store;
		dom.clearNode(this.items);
		this.rows.length = 0;
		this.renderedShape = this.listShape();
		const terms = this.searchInput.value.toLowerCase().split(/[\s、,]+/).filter(term => term.length > 0);
		const matches = (...texts: string[]) => {
			const haystack = texts.join('\n').toLowerCase();
			return terms.every(term => haystack.includes(term));
		};

		const addRow = (target: Target, label: string, description: string | undefined, mono: boolean) => {
			const selected = this.sameTarget(target, this.target);
			const row = dom.append(this.items, $('.paradis-tce-item', { role: 'option', tabindex: selected ? '0' : '-1', 'aria-selected': String(selected) }));
			row.classList.toggle('selected', selected);
			const swatch = dom.append(row, $('span.paradis-tce-swatch'));
			const text = dom.append(row, $('span.paradis-tce-item-id', undefined, label));
			if (!mono) {
				text.style.fontFamily = 'inherit';
			}
			const badge = dom.append(row, $('span.paradis-tce-item-badge'));
			const entry: ISyntaxRow = { target, row, swatch, badge, swatchValue: undefined, badgeKey: undefined };
			this.rows.push(entry);
			this.updateRow(entry);
			if (description) {
				store.add(this.hoverService.setupDelayedHover(row, { content: description }));
			}
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.select(target)));
		};

		// よく使う
		const groups = PARADIS_TOKEN_GROUPS.filter(group => matches(groupLabel(group), group));
		if (groups.length) {
			dom.append(this.items, $('.paradis-tce-group', undefined, localize('paradis.themeColors.syntax.common', "よく使う（{0}）", groups.length)));
			for (const group of groups) {
				addRow({ kind: 'group', group }, groupLabel(group), group, false);
			}
		}

		// TextMate のスコープ
		dom.append(this.items, $('.paradis-tce-group', undefined, localize('paradis.themeColors.syntax.textmate', "詳しく（TextMate のスコープ）")));
		this.alignedRules().forEach((rule, index) => {
			if (rule.scope && matches(rule.scope)) {
				addRow({ kind: 'rule', index }, rule.scope, undefined, true);
			}
		});
		const add = dom.append(this.items, $('.paradis-tce-add'));
		paradisCreateButton(add, localize('paradis.themeColors.syntax.add', "+ スコープを追加"), store, () => this.addRule());

		// セマンティック
		const types = getTokenClassificationRegistry().getTokenTypes()
			.filter(type => !type.deprecationMessage && matches(type.id, type.description))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (types.length) {
			dom.append(this.items, $('.paradis-tce-group', undefined, localize('paradis.themeColors.syntax.semantic', "セマンティック（{0}）", types.length)));
			for (const type of types) {
				addRow({ kind: 'semantic', type: type.id }, type.id, type.description, true);
			}
		}
	}

	/** 1 行の色見本とバッジを、前回と変わったときだけ書き換える。 */
	private updateRow(entry: ISyntaxRow): void {
		const target = entry.target;
		const swatchValue = this.readStyle(target)?.foreground ?? this.themeStyle(target, true).foreground;
		if (entry.swatchValue !== swatchValue || entry.badgeKey === undefined) {
			entry.swatchValue = swatchValue;
			paradisSetSwatch(entry.swatch, swatchValue);
		}
		const saved = this.readSavedStyle(target);
		const current = this.readStyle(target);
		const unsaved = JSON.stringify(saved ?? null) !== JSON.stringify(current ?? null) || (target.kind === 'rule' && this.isRuleUnsaved(target.index));
		const badgeKey = unsaved ? 'unsaved' : current ? 'user' : '';
		if (entry.badgeKey === badgeKey) {
			return;
		}
		entry.badgeKey = badgeKey;
		dom.clearNode(entry.badge);
		if (badgeKey === 'unsaved') {
			dom.append(entry.badge, $('span.paradis-tce-badge.user', undefined, localize('paradis.themeColors.badge.unsavedShort', "未保存")));
		} else if (badgeKey === 'user') {
			dom.append(entry.badge, $('span.paradis-tce-badge.user', undefined, localize('paradis.themeColors.badge.user', "変更")));
		}
	}

	private isRuleUnsaved(index: number): boolean {
		const original = this.draftService.getScopedOriginal('token', this.settingsId).textMateRules;
		const current = this.rawRules()[index];
		return !Array.isArray(original) || JSON.stringify(original[index] ?? null) !== JSON.stringify(current ?? null);
	}

	private refreshSwatches(): void {
		for (const entry of this.rows) {
			this.updateRow(entry);
		}
	}

	private refresh(): void {
		if (!this.shown) {
			return;
		}
		if (this.renderedShape !== this.listShape()) {
			this.renderList();
		} else {
			this.refreshSwatches();
		}
		this.renderDetail(!dom.isAncestorOfActiveElement(this.picker.element));
	}

	private select(target: Target): void {
		this.target = target;
		for (const entry of this.rows) {
			const selected = this.sameTarget(entry.target, target);
			entry.row.classList.toggle('selected', selected);
			entry.row.setAttribute('tabindex', selected ? '0' : '-1');
			entry.row.setAttribute('aria-selected', String(selected));
		}
		this.renderDetail(true);
	}

	/** 一覧のキーボード操作: 上下の矢印で選び直し、Enter でピッカーへ移る。 */
	private onListKey(e: KeyboardEvent): void {
		if (!this.rows.length) {
			return;
		}
		const index = this.rows.findIndex(entry => this.sameTarget(entry.target, this.target));
		let next: number | undefined;
		switch (e.key) {
			case 'ArrowDown': next = Math.min(this.rows.length - 1, index + 1); break;
			case 'ArrowUp': next = Math.max(0, index - 1); break;
			case 'Home': next = 0; break;
			case 'End': next = this.rows.length - 1; break;
			case 'Enter':
			case ' ':
				if (dom.isHTMLElement(e.target) && e.target.classList.contains('paradis-tce-item')) {
					e.preventDefault();
					this.picker.focus();
				}
				return;
		}
		if (next === undefined) {
			return;
		}
		e.preventDefault();
		const entry = this.rows[next];
		this.select(entry.target);
		entry.row.focus();
		entry.row.scrollIntoView({ block: 'nearest' });
	}

	private renderDetail(resetPicker: boolean): void {
		if (!this.shown) {
			return;
		}
		const target = this.target;
		const style = this.readStyle(target);
		const themeStyle = this.themeStyle(target, false);
		const liveStyle = this.themeStyle(target, true);
		const paraStyle = this.paraDefaultStyle(target);
		const themeLabel = this.themeService.getColorTheme().label;

		this.detailTitle.textContent = this.targetLabel(target);
		this.detailTitle.style.fontFamily = target.kind === 'group' ? 'inherit' : '';
		switch (target.kind) {
			case 'group':
				this.detailDescription.textContent = localize('paradis.themeColors.syntax.groupDesc', "「{0}」にまとめて当たるスコープの色を変えます。斜体・太字も指定できます。", groupLabel(target.group));
				break;
			case 'rule':
				this.detailDescription.textContent = localize('paradis.themeColors.syntax.ruleDesc', "このスコープに当たる文字の色を変えます。カンマで区切ると複数のスコープに当てられます。");
				break;
			case 'semantic':
				this.detailDescription.textContent = getTokenClassificationRegistry().getTokenTypes().find(type => type.id === target.type)?.description ?? '';
				break;
		}
		const notes: string[] = [];
		if (target.kind === 'semantic') {
			notes.push(localize('paradis.themeColors.syntax.semanticNote', "セマンティックの色は、言語の拡張が意味で色を付けている所（TypeScript のファイルなど）にだけ効きます。下のプレビューには出ません。"));
		}
		if (this.workspaceDefines(target)) {
			notes.push(localize('paradis.themeColors.syntax.workspaceWins', "ワークスペースの設定がこの色を上書きしているため、ここで変えても保存後はワークスペースの値が使われます（プレビューもワークスペースの値で見せます）。"));
		}
		const note = notes.join(' ');
		this.detailNote.textContent = note;
		this.detailNote.style.display = note ? '' : 'none';

		this.scopeInput.style.display = target.kind === 'rule' ? '' : 'none';
		if (target.kind === 'rule' && dom.getActiveElement() !== this.scopeInput) {
			this.scopeInput.value = this.alignedRules()[target.index]?.scope ?? '';
		}

		if (resetPicker) {
			const hex = style?.foreground ?? liveStyle.foreground;
			this.picker.setColor(hex ? Color.Format.CSS.parseHex(hex) ?? undefined : undefined);
		}
		const effectiveFontStyle = style?.fontStyle ?? liveStyle.fontStyle;
		for (const [flag, button] of this.toggleButtons) {
			const on = paradisHasFontStyle(effectiveFontStyle, flag);
			button.classList.toggle('on', on);
			button.setAttribute('aria-pressed', String(on));
		}

		const describe = (value: IParadisTokenStyle | undefined) => value && (value.foreground !== undefined || value.fontStyle) ? [value.foreground, value.fontStyle].filter(part => !!part).join(' / ') : undefined;
		const rows: IParadisLayerRow[] = [
			{ label: localize('paradis.themeColors.ui.layerUser', "自分で変えた色"), value: describe(style), swatch: style?.foreground, active: !!style },
		];
		if (paraStyle) {
			rows.push({ label: localize('paradis.themeColors.ui.layerPara', "Para Code の既定"), value: describe(paraStyle), swatch: paraStyle.foreground, active: !style });
		}
		rows.push({ label: localize('paradis.themeColors.ui.layerTheme', "テーマ（{0}）の色", themeLabel), value: describe(themeStyle), swatch: themeStyle.foreground, active: !style && !paraStyle });
		paradisRenderLayerRows(this.layers, rows);

		this.clearButton.label = target.kind === 'rule'
			? localize('paradis.themeColors.syntax.removeRule', "このスコープの規則を消す")
			: localize('paradis.themeColors.ui.revertTheme', "テーマの色に戻す");
		this.clearButton.enabled = target.kind === 'rule' || !!style;
	}

	// --- プレビュー ---

	private renderPreview(): void {
		if (!this.shown) {
			return;
		}
		for (const [language, button] of this.languageButtons) {
			button.classList.toggle('on', language === this.language);
		}
		if (!this.previewEditor) {
			this.previewEditor = this._register(this.instantiationService.createInstance(CodeEditorWidget, this.previewContainer, PREVIEW_OPTIONS, { isSimpleWidget: true }));
			this.previewHit = this.previewEditor.createDecorationsCollection();
			this._register(this.previewEditor.onMouseDown(e => {
				if (e.target.position) {
					this.inspectAt(e.target.position);
				}
			}));
		}
		const sample = PREVIEW_SAMPLES[this.language];
		const model = this.modelService.createModel(sample.text, this.languageService.createById(this.language), URI.from({ scheme: 'paradis-theme-preview', path: `/sample-${++previewModelCounter}` }), true);
		this.previewEditor.setModel(model);
		this.previewModel.value = model;
		this.previewHit?.clear();
		this.renderPreviewInfo(undefined);
	}

	private renderPreviewInfo(content: { scope: string; matched: string; addScope?: string } | undefined): void {
		const store = new DisposableStore();
		this.previewInfoStore.value = store;
		dom.clearNode(this.previewInfo);
		if (!content) {
			return;
		}
		dom.append(this.previewInfo, $('span', undefined, localize('paradis.themeColors.syntax.scopeLabel', "スコープ:")));
		dom.append(this.previewInfo, $('code', undefined, content.scope));
		dom.append(this.previewInfo, $('span', undefined, localize('paradis.themeColors.syntax.matched', "/ 選んだもの: {0}", content.matched)));
		if (content.addScope) {
			const scope = content.addScope;
			paradisCreateChip(this.previewInfo, localize('paradis.themeColors.syntax.addScope', "「{0}」の規則を追加", scope), store, () => this.addRule(scope));
		}
	}

	private async inspectAt(position: Position): Promise<void> {
		const model = this.previewEditor?.getModel();
		if (!model) {
			return;
		}
		const grammar = await this.textMateService.createTokenizer(model.getLanguageId());
		if (!grammar || this.previewEditor?.getModel() !== model) {
			this.renderPreviewInfo({ scope: '-', matched: localize('paradis.themeColors.syntax.noGrammar', "この言語のスコープは調べられません") });
			return;
		}
		let state: Parameters<typeof grammar.tokenizeLine>[1] = null;
		let tokens: { startIndex: number; endIndex: number; scopes: string[] }[] = [];
		for (let line = 1; line <= position.lineNumber; line++) {
			const result = grammar.tokenizeLine(model.getLineContent(line), state);
			state = result.ruleStack;
			tokens = result.tokens;
		}
		const offset = position.column - 1;
		const token = tokens.find(t => t.startIndex <= offset && offset < t.endIndex) ?? tokens[tokens.length - 1];
		if (!token) {
			return;
		}
		this.previewHit?.set([{
			range: new Range(position.lineNumber, token.startIndex + 1, position.lineNumber, token.endIndex + 1),
			options: { description: 'paradis-theme-color-preview-hit', inlineClassName: 'paradis-tce-preview-hit' },
		}]);
		const innermost = token.scopes[token.scopes.length - 1];
		const matched = paradisMatchSyntaxTarget(token.scopes, this.alignedRules());
		if (!matched) {
			this.renderPreviewInfo({ scope: innermost, matched: localize('paradis.themeColors.syntax.matchedNone', "なし（テーマの既定の文字色）") });
			return;
		}
		if (matched.kind === 'newRule') {
			this.renderPreviewInfo({ scope: innermost, matched: localize('paradis.themeColors.syntax.matchedNoRule', "当たる規則がありません"), addScope: matched.scope });
			return;
		}
		const target: Target = matched.kind === 'rule' ? { kind: 'rule', index: matched.index } : { kind: 'group', group: matched.group };
		this.select(target);
		this.renderPreviewInfo({ scope: innermost, matched: this.targetLabel(target), addScope: matched.kind === 'group' ? innermost : undefined });
	}
}
