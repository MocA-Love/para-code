/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 新しい Bot（Bot の帯の ＋ から開く S 段のモーダル。モック bots-paradot-mock.html 第 3 版の作成の画面）。
// テンプレート・名前・役割・エージェントを入れて作る。役割は人格メモ（SOUL.md）の種として本体へ渡す。
// 幕に paradis-modal-backdrop を付けるので、内蔵ブラウザの前にも出る（overlayManager.ts に登録済みの印）。
//
// 包んでいる本家のファイル: 無し（箱は paradisModal.ts、フォーカスの閉じ込めと Esc は paradisModalFocus.ts）。

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ParadisButton, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisBotsService, PARADIS_BOTS_ENABLED_SETTING } from '../common/paradisBotsApi.js';
import { PARADIS_BOT_CREATE_AGENTS, PARADIS_BOT_ROLE_MAX_LENGTH, PARADIS_BOT_TEMPLATES, paradisBotCreateSoul, paradisBotNameProblemMessage, paradisValidateBotName } from '../common/paradisBotsBandModel.js';
import { PARADIS_BOT_LIMITS, paradisBotDefaultFace } from '../common/paradisBots.js';
import { renderParadisBotFace } from './paradisBotFace.js';

const $ = dom.$;

const AGENT_LABELS: Record<string, string> = {
	claude: 'Claude Code',
	codex: 'Codex',
};

let activeDialog: ParadisBotCreateDialog | undefined;

/** 新しい Bot のモーダル。開いている間にもう一度開くと、前のものを閉じる。 */
export class ParadisBotCreateDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly nameField: ParadisInputField;
	/** 名前の左の顔の見本（名前から決まる既定の顔。作るときに同じ顔を渡す）。 */
	private readonly facePreview: HTMLElement;
	private readonly roleInput: HTMLTextAreaElement;
	private readonly agents: ParadisSegmented<ParadisAgentKind>;
	private readonly note: HTMLElement;
	private readonly createButton: ParadisButton;
	/** 名前を一度でも触ったか（触る前は空でも誤りの文を出さない）。 */
	private nameTouched = false;
	private creating = false;

	constructor(
		restoreFocusTo: HTMLElement | undefined,
		private readonly onDidCreate: (botId: string) => void,
		@ILayoutService layoutService: ILayoutService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService contextViewService: IContextViewService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		activeDialog?.dispose();
		activeDialog = this;

		this.backdrop = $(`.paradis-bot-create-backdrop.${PARADIS_MODAL_BACKDROP_CLASS}`);
		const modal = dom.append(this.backdrop, $('.paradis-bot-create'));
		modal.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		modal.tabIndex = -1;
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');

		const title = localize('paradis.bots.create.title', "新しい Bot");
		const head = renderParadisModalHead(modal, title);
		head.title.id = 'paradis-bot-create-title';
		modal.setAttribute('aria-labelledby', head.title.id);
		const closeLabel = localize('paradis.bots.create.close', "閉じる");
		const close = dom.append(head.actions, $('button.pbcd-close')) as HTMLButtonElement;
		close.classList.add(...paradisButtonClasses('icon'));
		close.type = 'button';
		close.setAttribute('aria-label', closeLabel);
		this._register(hoverService.setupDelayedHover(close, { content: closeLabel }));
		dom.append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.dispose()));

		const body = dom.append(modal, $(`.${PARADIS_MODAL_BODY_CLASS}`));

		// テンプレート（選ぶと名前と役割を埋める）
		const templateLabel = localize('paradis.bots.create.template', "テンプレート");
		dom.append(body, $('label.pbcd-label')).textContent = templateLabel;
		const template = this._register(new ParadisSelect(body, contextViewService, configurationService,
			PARADIS_BOT_TEMPLATES.map(item => ({ value: item.id, label: item.label })), PARADIS_BOT_TEMPLATES[0].id, { ariaLabel: templateLabel }));

		// 絵と名前
		const nameLabel = localize('paradis.bots.create.name', "絵と名前");
		dom.append(body, $('label.pbcd-label')).textContent = nameLabel;
		const nameRow = dom.append(body, $('.pbcd-name-row'));
		this.facePreview = dom.append(nameRow, $('.pbcd-face'));
		this.nameField = this._register(new ParadisInputField(nameRow, { ariaLabel: nameLabel, placeholder: localize('paradis.bots.create.namePlaceholder', "例: CI の見張り") }));
		this._register(this.nameField.onDidChange(() => {
			this.nameTouched = true;
			this.update();
		}));

		// 役割
		const roleLabel = localize('paradis.bots.create.role', "役割（何者で、何をするか）");
		dom.append(body, $('label.pbcd-label')).textContent = roleLabel;
		const roleFrame = dom.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.pbcd-role'));
		this.roleInput = dom.append(roleFrame, $('textarea')) as HTMLTextAreaElement;
		this.roleInput.rows = 3;
		this.roleInput.maxLength = PARADIS_BOT_ROLE_MAX_LENGTH;
		this.roleInput.spellcheck = false;
		this.roleInput.setAttribute('aria-label', roleLabel);

		// エージェント
		const agentLabel = localize('paradis.bots.create.agent', "エージェント");
		dom.append(body, $('label.pbcd-label')).textContent = agentLabel;
		this.agents = this._register(new ParadisSegmented<ParadisAgentKind>(body, {
			items: PARADIS_BOT_CREATE_AGENTS.map(kind => ({ value: kind, label: AGENT_LABELS[kind] ?? kind })),
			value: PARADIS_BOT_CREATE_AGENTS[0],
			ariaLabel: agentLabel,
		}));

		dom.append(body, $('.pbcd-help')).textContent = localize('paradis.bots.create.help', "専用フォルダ ~/.para-code/bots/ に人格メモ（SOUL.md）と記憶（MEMORY.md）を作ります。");

		this._register(template.onDidChange(id => {
			const picked = PARADIS_BOT_TEMPLATES.find(item => item.id === id);
			if (picked) {
				this.nameField.value = picked.name;
				this.roleInput.value = picked.role;
				this.nameTouched = picked.name.length > 0;
				this.update();
			}
		}));

		// 下の帯
		const foot = dom.append(modal, $(`.${PARADIS_MODAL_FOOT_CLASS}`));
		this.note = dom.append(foot, $('span.pbcd-note'));
		this.note.setAttribute('role', 'status');
		const cancel = this._register(new ParadisButton(foot, { kind: 'secondary', label: localize('paradis.bots.create.cancel', "やめる") }));
		this._register(cancel.onDidClick(() => this.dispose()));
		this.createButton = this._register(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.bots.create.submit', "作る") }));
		this._register(this.createButton.onDidClick(() => void this.create()));

		this._register(dom.addDisposableListener(modal, dom.EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			// 日本語の変換を確定する Enter では作らない
			if ((keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.Enter) || (keyboardEvent.equals(KeyCode.Enter) && dom.isAncestor(event.target as Node, this.nameField.element))) && !event.isComposing) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				void this.create();
			}
		}));
		this._register(dom.addDisposableListener(this.backdrop, dom.EventType.MOUSE_DOWN, event => {
			// 何か入れているときは、幕の外を押しても閉じない
			if (event.target === this.backdrop && !this.nameField.value.trim() && !this.roleInput.value.trim()) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal,
			onEscape: () => this.dispose(),
			close: () => this.dispose(),
			restoreFallback: () => restoreFocusTo?.isConnected ? restoreFocusTo : undefined,
		}));
		// 開いている間に設定で Bot をオフにしたら閉じる（帯と一緒に消えた Bot の作成を残さない）
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_BOTS_ENABLED_SETTING) && configurationService.getValue<boolean>(PARADIS_BOTS_ENABLED_SETTING) !== true) {
				this.dispose();
			}
		}));
		this.update();
		this.nameField.focus();
	}

	/** 名前を検め、下の帯の文と「作る」の可否を合わせる。 */
	private update(): void {
		dom.clearNode(this.facePreview);
		const face = this.face();
		renderParadisBotFace(this.facePreview, { shape: face.faceShape, color: face.faceColor });
		const checked = paradisValidateBotName(this.nameField.value, this.botsService.snapshot.bots);
		this.createButton.enabled = checked.ok && !this.creating;
		const showProblem = !checked.ok && (this.nameTouched || checked.problem !== 'empty');
		this.note.textContent = showProblem
			? paradisBotNameProblemMessage(checked.problem)
			: localize('paradis.bots.create.nameHelp', "名前は {0} 字まで。同じ名前は使えません", PARADIS_BOT_LIMITS.name);
		this.note.classList.toggle('error', showProblem);
	}

	private async create(): Promise<void> {
		const checked = paradisValidateBotName(this.nameField.value, this.botsService.snapshot.bots);
		if (!checked.ok || this.creating) {
			this.nameTouched = true;
			this.update();
			return;
		}
		this.creating = true;
		this.update();
		const face = this.face();
		const result = await this.botsService.createBot({ name: checked.name, agent: this.agents.value ?? PARADIS_BOT_CREATE_AGENTS[0], faceColor: face.faceColor, faceShape: face.faceShape }, paradisBotCreateSoul(checked.name, this.roleInput.value));
		if (this._store.isDisposed) {
			return;
		}
		this.creating = false;
		if (!result.ok) {
			this.update();
			this.note.textContent = localize('paradis.bots.create.failed', "作れませんでした: {0}", result.message);
			this.note.classList.add('error');
			return;
		}
		this.dispose();
		this.onDidCreate(result.value.id);
	}

	/** 見本の顔。名前がまだ空なら「新」から決まる顔。 */
	private face(): ReturnType<typeof paradisBotDefaultFace> {
		return paradisBotDefaultFace(this.nameField.value.trim() || localize('paradis.bots.create.faceSeed', "新"));
	}

	override dispose(): void {
		if (activeDialog === this) {
			activeDialog = undefined;
		}
		this.backdrop.remove();
		super.dispose();
	}
}
