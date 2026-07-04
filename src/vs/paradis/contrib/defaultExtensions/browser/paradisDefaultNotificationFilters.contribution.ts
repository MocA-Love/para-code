/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 既定拡張のうち「動作は必要だが通知トーストが騒がしい」ものに、ソース単位の通知フィルタ
// (エラーのみ表示 = それ以外は通知センターへ静かに積まれる) を一度だけ既定設定する。
//
// 代表例: Dart 拡張はワークスペースフォルダが変わるたびに自身を再起動してプロジェクトを再走査し、
// 走査が長引くと毎回「Searching for projects...」の進捗通知を出す。Para Code はワークスペースの
// 即時切り替えが日常操作なので、切り替えのたびにこのトーストが出て煩わしい。
//
// INotificationService.setFilter は upstream の正式 API で、ユーザーが通知センター (ベルアイコン →
// 歯車) からいつでも解除・変更でき、その選択は APPLICATION スコープで永続される。ここでは
// 「まだユーザーがそのソースのフィルタを一度も設定していない」場合に限り一度だけ既定値を入れ、
// 以後は二度と触らない (storage に記録)。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { INotificationService, NotificationsFilter } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

/** 既定で「エラーのみ表示」にする通知ソース。id は拡張ID (mainThreadの通知sourceと完全一致させる)。 */
const DEFAULT_ERROR_ONLY_SOURCES: readonly { id: string; label: string }[] = [
	{ id: 'Dart-Code.dart-code', label: 'Dart' },
];

const SEEDED_STORAGE_KEY = 'paradis.seededNotificationFilters';

class ParadisDefaultNotificationFiltersContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDefaultNotificationFilters';

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
	) {
		super();

		let seeded: Set<string>;
		try {
			seeded = new Set<string>(JSON.parse(storageService.get(SEEDED_STORAGE_KEY, StorageScope.APPLICATION, '[]')));
		} catch {
			seeded = new Set<string>();
		}

		let changed = false;
		for (const source of DEFAULT_ERROR_ONLY_SOURCES) {
			if (seeded.has(source.id)) {
				continue;
			}
			// 通知サービスは「通知を一度でも出したソース」を filter=OFF で自動登録するため、
			// 「フィルタが存在する」だけではユーザーの意思とは限らない。OFF 以外 (= ユーザーが
			// 通知センターで明示的に変更した形跡) がある場合のみ尊重し、無い/OFF ならシードする。
			const existing = notificationService.getFilters().find(filter => filter.id === source.id);
			if (existing === undefined || existing.filter === NotificationsFilter.OFF) {
				notificationService.setFilter({ ...source, filter: NotificationsFilter.ERROR });
			}
			seeded.add(source.id);
			changed = true;
		}

		if (changed) {
			storageService.store(SEEDED_STORAGE_KEY, JSON.stringify([...seeded]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}
}

registerWorkbenchContribution2(ParadisDefaultNotificationFiltersContribution.ID, ParadisDefaultNotificationFiltersContribution, WorkbenchPhase.AfterRestored);
