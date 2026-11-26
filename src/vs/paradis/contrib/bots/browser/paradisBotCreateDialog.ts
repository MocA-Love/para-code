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
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ParadisButton, paradisButtonClasses } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { PARADIS_MODAL_BACKDROP_CLASS, PARADIS_MODAL_BODY_CLASS, PARADIS_MODAL_FOOT_CLASS, paradisModalClasses, ParadisModalSize, renderParadisModalHead } from '../../../browser/paradisModal.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisBotsService } from '../common/paradisBotsApi.js';
import { PARADIS_BOT_CREATE_AGENTS, PARADIS_BOT_ROLE_MAX_LENGTH, paradisBotCreateSoul, paradisBotNameProblemMessage, paradisValidateBotName } from '../common/paradisBotsBandModel.js';
import { IParadisBotTemplate, paradisBotTemplateSkillFile, paradisBotTemplateSkillPaths, paradisBotTemplateSoul } from '../common/paradisBotTemplates.js';
import { IParadisBotTemplatePick, ParadisBotTemplatesDialog } from './paradisBotTemplatesDialog.js';
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
	/** 選んだテンプレート（白紙なら undefined）と、付属のスキルを入れるか。 */
	private template: IParadisBotTemplate | undefined;
	private withSkill = false;
	private readonly templateName: HTMLElement;
	private readonly templateButton: ParadisButton;
	/** 重ねて開いたテンプレートの一覧（作成のモーダルを閉じたら一緒に閉じる）。 */
	private readonly templatesDialog = this._register(new MutableDisposable<ParadisBotTemplatesDialog>());

	constructor(
		restoreFocusTo: HTMLElement | undefined,
		private readonly onDidCreate: (botId: string) => void,
		/** 開いてすぐテンプレートの一覧を重ねる（帯の ＋ の「テンプレートから選ぶ...」）。 */
		openTemplates: boolean,
		@ILayoutService layoutService: ILayoutService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
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

		// テンプレート（M のモーダルで選ぶと、名前と役割を埋める）
		const templateLabel = localize('paradis.bots.create.template', "テンプレート");
		dom.append(body, $('label.pbcd-label')).textContent = templateLabel;
		const templateRow = dom.append(body, $('.pbcd-template-row'));
		this.templateName = dom.append(templateRow, $('span.pbcd-template-name'));
		this.templateButton = this._register(new ParadisButton(templateRow, { kind: 'secondary', label: localize('paradis.bots.create.pickTemplate', "テンプレートから選ぶ...") }));
		this._register(this.templateButton.onDidClick(() => this.openTemplates()));

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
		this.update();
		this.nameField.focus();
		if (openTemplates) {
			this.openTemplates();
		}
	}

	private openTemplates(): void {
		this.templatesDialog.value = this.instantiationService.createInstance(ParadisBotTemplatesDialog, this.templateButton.element, this.template?.id, (pick: IParadisBotTemplatePick) => this.applyTemplate(pick));
	}

	/** テンプレートを当てる。名前と役割は、空か前のテンプレートのままなら書き換える（自分で書いた文は消さない）。 */
	private applyTemplate(pick: IParadisBotTemplatePick): void {
		if (this._store.isDisposed) {
			return;
		}
		const previous = this.template;
		const name = this.nameField.value.trim();
		const role = this.roleInput.value.trim();
		if (name.length === 0 || name === previous?.name) {
			this.nameField.value = pick.template?.name ?? '';
		}
		if (role.length === 0 || role === previous?.role) {
			this.roleInput.value = pick.template?.role ?? '';
		}
		this.template = pick.template;
		this.withSkill = pick.withSkill;
		this.nameTouched = this.nameField.value.length > 0;
		this.update();
		this.nameField.focus();
	}

	/** 名前を検め、下の帯の文と「作る」の可否を合わせる。 */
	private update(): void {
		this.templateName.textContent = this.template !== undefined
			? (this.withSkill && this.template.skill !== undefined ? localize('paradis.bots.create.templateWithSkill', "{0}（スキル {1}）", this.template.name, this.template.skill.name) : this.template.name)
			: localize('paradis.bots.create.blank', "白紙");
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
		const template = this.template;
		const soul = template !== undefined ? paradisBotTemplateSoul(checked.name, this.roleInput.value, template, this.withSkill) : paradisBotCreateSoul(checked.name, this.roleInput.value);
		const result = await this.botsService.createBot({ name: checked.name, agent: this.agents.value ?? PARADIS_BOT_CREATE_AGENTS[0], faceColor: face.faceColor, faceShape: face.faceShape }, soul);
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
		if (template?.skill !== undefined && this.withSkill) {
			void this.writeSkill(result.value.id, result.value.name, template);
		}
		this.dispose();
		this.onDidCreate(result.value.id);
	}

	/** 付属のスキルを専用フォルダへ書く。書けなくても Bot は作れているので、知らせるだけ。 */
	private async writeSkill(botId: string, botName: string, template: IParadisBotTemplate): Promise<void> {
		const skill = template.skill!;
		const text = paradisBotTemplateSkillFile(skill);
		for (const path of paradisBotTemplateSkillPaths(skill)) {
			const written = await this.botsService.writeHomeFile(botId, path, text);
			if (!written.ok) {
				this.notificationService.warn(localize('paradis.bots.create.skillFailed', "Bot「{0}」のスキル {1} を置けませんでした: {2}", botName, skill.name, written.message));
				return;
			}
		}
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
