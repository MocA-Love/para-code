/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 歯車メニュー →「スキル」で開くモーダル。左にマシンごとのスキルのフォルダ、右にスキルの一覧と中身。
// 形は使用量ダイアログ・定期実行のモーダル（左ナビ＋本文）に揃えている。
//
// ファイルを書き換えるのは「削除」「導入」のボタンを押して確認に「はい」と答えたときだけ。
// 内蔵ブラウザの裏に隠れないよう、backdrop に共通の印 `paradis-modal-backdrop`（overlayManager.ts に登録済み）を付ける。
// 重ね順はワークベンチのモーダル（2575）より下に置き、確認に IDialogService を使う。

import './media/paradisSkills.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import {
	IParadisSkill,
	IParadisSkillRoot,
	IParadisSkillRootListing,
	paradisDedupeSkillListings,
	paradisDeleteSkill,
	paradisInstallSkill,
	paradisListSkills,
	paradisReadSkillFile,
	paradisSkillDeleteBlocker,
	paradisSkillDeleteUsesTrash,
	paradisSkillInstallBlocker,
	paradisSkillInstallSource,
	paradisSkillInstallTarget,
	paradisSkillRootLabel,
} from '../common/paradisSkills.js';
import { paradisResolveSkillRoots } from './paradisSkillRoots.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';

const $ = dom.$;

export class ParadisSkillsDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly modal: HTMLElement;
	private readonly nav: HTMLElement;
	private readonly message: HTMLElement;
	private readonly content: HTMLElement;
	private readonly navDisposables = this._register(new DisposableStore());
	private readonly contentDisposables = this._register(new DisposableStore());

	private listings: IParadisSkillRootListing[] = [];
	private selectedRootId: string | undefined;
	private selectedSkill: IParadisSkill | undefined;
	private loading = false;
	private busy = false;

	constructor(
		@ILayoutService layoutService: ILayoutService,
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IPathService private readonly pathService: IPathService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILabelService private readonly labelService: ILabelService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.backdrop = $('.paradis-skills-backdrop.paradis-modal-backdrop');
		this.modal = dom.append(this.backdrop, $('.paradis-skills'));
		this.modal.setAttribute('role', 'dialog');
		this.modal.setAttribute('aria-modal', 'true');

		const header = dom.append(this.modal, $('.psk-header'));
		const title = dom.append(header, $('h2'));
		title.id = 'paradis-skills-title';
		title.textContent = localize('paradis.skills.title', "スキル");
		this.modal.setAttribute('aria-labelledby', title.id);
		dom.append(header, $('span.psk-header-note')).textContent = localize('paradis.skills.headerNote', "Claude Code・Codex・共通の .agents のスキル");
		dom.append(header, $('.psk-spacer'));
		const refresh = this.button(header, localize('paradis.skills.refresh', "読み直す"), 'secondary', Codicon.refresh);
		this._register(dom.addDisposableListener(refresh, 'click', () => this.load()));
		const close = dom.append(header, $('button.psk-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.skills.close', "閉じる"));
		close.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._register(dom.addDisposableListener(close, 'click', () => this.dispose()));

		const body = dom.append(this.modal, $('.psk-body'));
		this.nav = dom.append(body, $('nav.psk-nav'));
		const main = dom.append(body, $('.psk-main'));
		this.message = dom.append(main, $('.psk-message'));
		this.message.setAttribute('role', 'status');
		this.content = dom.append(main, $('.psk-content'));

		this.modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this.backdrop, 'mousedown', e => {
			if (e.target === this.backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this.backdrop);
		// 開く前のフォーカスを覚えて閉じたら戻す・Esc はモーダル全体で受ける・描き直しで外れたフォーカスを
		// 押していたボタンへ戻す・後から開いたモーダルを前に出す（「設定 (Para Code)」と同じ仕組み）
		this._register(new ParadisModalFocus({
			backdrop: this.backdrop,
			modal: this.modal,
			onEscape: () => {
				if (this.selectedSkill) {
					this.selectedSkill = undefined;
					this.renderContent();
				} else {
					this.dispose();
				}
			},
			close: () => this.dispose(),
		}));
		this.modal.focus();
		this.load();
	}

	override dispose(): void {
		this.backdrop.remove();
		super.dispose();
	}

	// ---------- 読み込み ----------

	private async load(): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		dom.clearNode(this.content);
		dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.loading', "読み込んでいます…");
		try {
			const roots = await paradisResolveSkillRoots({
				pathService: this.pathService,
				environmentService: this.environmentService,
				labelService: this.labelService,
				switchService: this.switchService,
				logService: this.logService,
			});
			const listings = await Promise.all(roots.map(root => paradisListSkills(this.fileService, root).catch(error => ({ root, exists: false, skills: [], error: toErrorMessage(error) }))));
			if (this._store.isDisposed) {
				return;
			}
			this.listings = paradisDedupeSkillListings(listings);
			if (!this.listings.some(listing => listing.root.id === this.selectedRootId)) {
				this.selectedRootId = (this.listings.find(listing => listing.skills.length > 0) ?? this.listings[0])?.root.id;
			}
			if (this.selectedSkill) {
				const current = this.listing(this.selectedSkill.root.id)?.skills.find(skill => skill.folderName === this.selectedSkill!.folderName);
				this.selectedSkill = current;
			}
		} catch (error) {
			this.logService.warn('[ParadisSkills] listing failed', error);
			this.showMessage(localize('paradis.skills.loadFailed', "スキルの一覧を読めませんでした: {0}", toErrorMessage(error)), 'error');
		} finally {
			this.loading = false;
		}
		if (!this._store.isDisposed) {
			this.renderNav();
			this.renderContent();
		}
	}

	private listing(rootId: string | undefined): IParadisSkillRootListing | undefined {
		return this.listings.find(listing => listing.root.id === rootId);
	}

	// ---------- 左の一覧 ----------

	private renderNav(): void {
		this.navDisposables.clear();
		dom.clearNode(this.nav);
		let lastHost: string | undefined;
		for (const listing of this.listings) {
			if (listing.root.host.id !== lastHost) {
				lastHost = listing.root.host.id;
				dom.append(this.nav, $('.psk-nav-caption')).textContent = listing.root.host.label;
			}
			const item = dom.append(this.nav, $('button.psk-nav-item')) as HTMLButtonElement;
			item.type = 'button';
			item.classList.toggle('active', listing.root.id === this.selectedRootId);
			item.classList.toggle('empty', !listing.exists || listing.skills.length === 0);
			dom.append(item, $('span.psk-nav-label')).textContent = paradisSkillRootLabel(listing.root);
			dom.append(item, $('span.psk-nav-count')).textContent = listing.aliasOf !== undefined ? '=' : listing.exists ? String(listing.skills.length) : '—';
			item.title = listing.root.uri.scheme === 'file' ? listing.root.uri.fsPath : listing.root.uri.path;
			this.navDisposables.add(dom.addDisposableListener(item, 'click', () => {
				this.selectedRootId = listing.root.id;
				this.selectedSkill = undefined;
				this.clearMessage();
				this.renderNav();
				this.renderContent();
			}));
		}
	}

	private displayPath(root: IParadisSkillRoot): string {
		return this.displayUri(root.uri);
	}

	private displayUri(uri: URI): string {
		return uri.scheme === 'file' ? uri.fsPath : uri.path;
	}

	// ---------- 右の本文 ----------

	private renderContent(): void {
		this.contentDisposables.clear();
		dom.clearNode(this.content);
		if (this.selectedSkill) {
			this.renderSkill(this.selectedSkill);
			return;
		}
		const listing = this.listing(this.selectedRootId);
		if (!listing) {
			dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.noRoots', "スキルのフォルダが見つかりません。");
			return;
		}
		const head = dom.append(this.content, $('.psk-section-head'));
		dom.append(head, $('h3')).textContent = paradisSkillRootLabel(listing.root);
		dom.append(head, $('code.psk-path')).textContent = this.displayPath(listing.root);
		if (listing.error) {
			dom.append(this.content, $('.psk-error')).textContent = listing.error;
		}
		if (listing.aliasOf !== undefined) {
			const original = this.listing(listing.aliasOf);
			dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.aliasRoot', "このフォルダは「{0}」と同じ実体です（リンク、または同じ場所）。スキルはそちらに出しています。", original ? `${original.root.host.label} · ${paradisSkillRootLabel(original.root)}` : '');
			return;
		}
		if (listing.realUri && listing.realUri.toString() !== listing.root.uri.toString()) {
			dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.rootIsLink', "このフォルダはリンクです。実体: {0}", this.displayUri(listing.realUri));
		}
		if (!listing.exists) {
			dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.missingRoot', "このフォルダはまだありません。ほかの場所のスキルを「導入」すると作ります。");
			return;
		}
		if (listing.skills.length === 0) {
			dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.emptyRoot', "スキルはありません。");
			return;
		}
		const list = dom.append(this.content, $('.psk-list'));
		for (const skill of listing.skills) {
			const row = dom.append(list, $('button.psk-row')) as HTMLButtonElement;
			row.type = 'button';
			const main = dom.append(row, $('span.psk-row-main'));
			const nameLine = dom.append(main, $('span.psk-row-name'));
			dom.append(nameLine, $('span')).textContent = skill.name;
			this.badges(nameLine, skill);
			dom.append(main, $('span.psk-row-desc')).textContent = skill.description;
			dom.append(row, $(`span.psk-row-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
			this.contentDisposables.add(dom.addDisposableListener(row, 'click', () => {
				this.selectedSkill = skill;
				this.clearMessage();
				this.renderContent();
			}));
		}
	}

	private badges(container: HTMLElement, skill: IParadisSkill): void {
		if (skill.folderName !== skill.name) {
			dom.append(container, $('span.psk-badge')).textContent = skill.folderName;
		}
		if (skill.bundled) {
			dom.append(container, $('span.psk-badge')).textContent = localize('paradis.skills.badge.bundled', "同梱");
		}
		if (skill.isSymbolicLink) {
			dom.append(container, $('span.psk-badge')).textContent = localize('paradis.skills.badge.link', "リンク");
		}
	}

	private renderSkill(skill: IParadisSkill): void {
		const back = this.button(this.content, localize('paradis.skills.back', "一覧へ戻る"), 'link', Codicon.arrowLeft);
		this.contentDisposables.add(dom.addDisposableListener(back, 'click', () => {
			this.selectedSkill = undefined;
			this.renderContent();
		}));
		const head = dom.append(this.content, $('.psk-section-head'));
		const titleLine = dom.append(head, $('h3'));
		dom.append(titleLine, $('span')).textContent = skill.name;
		this.badges(titleLine, skill);
		dom.append(head, $('.psk-row-desc')).textContent = skill.description;
		dom.append(head, $('code.psk-path')).textContent = skill.uri.scheme === 'file' ? skill.uri.fsPath : skill.uri.path;
		dom.append(head, $('.psk-muted')).textContent = `${skill.root.host.label} · ${paradisSkillRootLabel(skill.root)}`;

		// 導入
		const actions = dom.append(this.content, $('.psk-actions'));
		// 同じ実体のフォルダ（リンク・重複）へは導入先として出さない
		const sourceReal = (this.listing(skill.root.id)?.realUri ?? skill.root.uri).toString();
		const targets = this.listings
			.filter(listing => listing.aliasOf === undefined && (listing.realUri ?? listing.root.uri).toString() !== sourceReal)
			.map(listing => listing.root)
			.filter(root => paradisSkillInstallBlocker(skill, root) === undefined);
		if (targets.length > 0) {
			dom.append(actions, $('span.psk-muted')).textContent = localize('paradis.skills.installTo', "導入先");
			const select = dom.append(actions, $('select.psk-select')) as HTMLSelectElement;
			for (const root of targets) {
				const option = dom.append(select, $('option')) as HTMLOptionElement;
				option.value = root.id;
				option.textContent = `${root.host.label} · ${paradisSkillRootLabel(root)}`;
			}
			const install = this.button(actions, localize('paradis.skills.install', "導入…"), 'primary', Codicon.cloudDownload);
			this.contentDisposables.add(dom.addDisposableListener(install, 'click', () => {
				const target = targets.find(root => root.id === select.value);
				if (target) {
					this.install(skill, target);
				}
			}));
		}
		dom.append(actions, $('.psk-spacer'));
		const blocker = paradisSkillDeleteBlocker(skill);
		const remove = this.button(actions, localize('paradis.skills.delete', "削除…"), 'danger', Codicon.trash);
		if (blocker) {
			remove.disabled = true;
			remove.title = blocker;
		}
		this.contentDisposables.add(dom.addDisposableListener(remove, 'click', () => this.delete(skill)));

		// 中身
		const pre = dom.append(this.content, $('pre.psk-file'));
		pre.textContent = localize('paradis.skills.reading', "読み込んでいます…");
		paradisReadSkillFile(this.fileService, skill).then(({ text, truncated }) => {
			if (this.selectedSkill !== skill) {
				return;
			}
			pre.textContent = text;
			if (truncated) {
				dom.append(this.content, $('.psk-muted')).textContent = localize('paradis.skills.truncated', "長いため先頭だけを表示しています。");
			}
		}, error => {
			pre.textContent = localize('paradis.skills.readFailed', "SKILL.md を読めませんでした: {0}", toErrorMessage(error));
		});
	}

	// ---------- 操作 ----------

	private async install(skill: IParadisSkill, target: IParadisSkillRoot): Promise<void> {
		if (this.busy) {
			return;
		}
		const destination = paradisSkillInstallTarget(skill, target);
		const exists = await this.fileService.exists(destination).catch(() => false);
		const { confirmed } = await this.dialogService.confirm({
			type: exists ? 'warning' : 'question',
			message: exists
				? localize('paradis.skills.installOverwrite', "「{0}」は導入先にすでにあります。置き換えますか？", skill.name)
				: localize('paradis.skills.installConfirm', "「{0}」を導入しますか？", skill.name),
			detail: [
				localize('paradis.skills.installFrom', "写す元: {0} · {1}\n{2}", skill.root.host.label, paradisSkillRootLabel(skill.root), this.displayUri(paradisSkillInstallSource(skill))),
				localize('paradis.skills.installTo2', "導入先: {0} · {1}\n{2}", target.host.label, paradisSkillRootLabel(target), this.displayUri(destination)),
				'',
				skill.root.scope === 'project' && target.scope === 'user'
					? localize('paradis.skills.installProjectWarning', "写す元はリポジトリの中のスキルです。中身はリポジトリの作者が決められます。導入すると、このマシンのすべてのプロジェクトでエージェントが読みます。中身を確かめてから導入してください。")
					: localize('paradis.skills.installCopy', "スキルのフォルダをそのまま写します。"),
			].join('\n'),
			primaryButton: exists ? localize('paradis.skills.overwriteButton', "置き換える") : localize('paradis.skills.installButton', "導入"),
		});
		if (!confirmed || this._store.isDisposed) {
			return;
		}
		this.busy = true;
		try {
			await paradisInstallSkill(this.fileService, skill, target, exists);
			this.showMessage(localize('paradis.skills.installed', "「{0}」を {1} へ導入しました。", skill.name, `${target.host.label} · ${paradisSkillRootLabel(target)}`), 'info');
		} catch (error) {
			this.showMessage(localize('paradis.skills.installFailed', "導入できませんでした: {0}", toErrorMessage(error)), 'error');
		} finally {
			this.busy = false;
		}
		await this.load();
	}

	private async delete(skill: IParadisSkill): Promise<void> {
		if (this.busy || paradisSkillDeleteBlocker(skill)) {
			return;
		}
		const trash = paradisSkillDeleteUsesTrash(this.fileService, skill);
		const details = [
			skill.uri.scheme === 'file' ? skill.uri.fsPath : skill.uri.path,
			'',
			trash ? localize('paradis.skills.deleteTrash', "ごみ箱へ移します。") : localize('paradis.skills.deletePermanent', "このマシンではごみ箱を使えないため、元に戻せません。"),
		];
		if (skill.isSymbolicLink) {
			details.push(localize('paradis.skills.deleteLink', "これはリンクです。リンクだけを消し、リンク先のフォルダは残します。"));
		} else if (skill.realUri) {
			details.push(localize('paradis.skills.deleteReal', "スキルのフォルダはリンクの先にあります。消えるのは実体の {0} です。", this.displayUri(skill.realUri)));
		}
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('paradis.skills.deleteConfirm', "スキル「{0}」を削除しますか？", skill.name),
			detail: details.join('\n'),
			primaryButton: localize('paradis.skills.deleteButton', "削除"),
		});
		if (!confirmed || this._store.isDisposed) {
			return;
		}
		this.busy = true;
		try {
			await paradisDeleteSkill(this.fileService, skill);
			this.selectedSkill = undefined;
			this.showMessage(localize('paradis.skills.deleted', "「{0}」を削除しました。", skill.name), 'info');
		} catch (error) {
			this.showMessage(localize('paradis.skills.deleteFailed', "削除できませんでした: {0}", toErrorMessage(error)), 'error');
		} finally {
			this.busy = false;
		}
		await this.load();
	}

	// ---------- 部品 ----------

	private button(container: HTMLElement, label: string, kind: 'primary' | 'secondary' | 'danger' | 'link', icon?: ThemeIcon): HTMLButtonElement {
		const button = dom.append(container, $(`button.psk-button.${kind}`)) as HTMLButtonElement;
		button.type = 'button';
		if (icon) {
			button.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
		}
		dom.append(button, $('span')).textContent = label;
		return button;
	}

	private showMessage(text: string, severity: 'info' | 'error'): void {
		this.message.textContent = text;
		this.message.classList.toggle('error', severity === 'error');
		this.message.classList.toggle('visible', text.length > 0);
	}

	private clearMessage(): void {
		this.showMessage('', 'info');
	}
}
