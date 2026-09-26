// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { hapticSelection } from '../../src/haptics.js';
import { useParaToast } from '../../src/paraToast.js';
import { ListGroup, ListRow } from '../../src/ui/index.js';
import type { SessionView } from '../../src/features/settings/onboardingPlan.js';
import { effectiveSessionView, useSessionViewPreference } from '../../src/features/settings/onboardingStore.js';
import { GroupHeader, GroupNote, SettingsScreen } from '../../src/features/settings/settingsScaffold.js';

const OPTIONS: readonly { readonly value: SessionView; readonly label: string; readonly hint: string }[] = [
	{ value: 'chat', label: 'チャット UI', hint: '会話・承認・質問をカードで表示' },
	{ value: 'terminal', label: 'ターミナル', hint: 'PC と同じ画面をそのまま表示' },
];

/**
 * セッションの開き方（`/settings/session-view`。モックの「チャット UI」、Orca の native-chat-settings）。
 * 「はじめて」の1ページ目で選んだものを、ここで変えられる。この端末の中だけの設定で、PC へは送らない。
 */
export default function SessionViewSettingsScreen() {
	const view = useSessionViewPreference(effectiveSessionView);
	const load = useSessionViewPreference(s => s.load);
	const save = useSessionViewPreference(s => s.save);
	useEffect(() => { void load(); }, [load]);

	const choose = (next: SessionView) => {
		if (next === view) {
			return;
		}
		hapticSelection();
		save(next).catch(() => {
			useParaToast.getState().show({ key: 'session-view-save', text: '保存できませんでした', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
		});
	};

	return (
		<SettingsScreen title="チャット UI">
			<GroupHeader title="セッションの開き方" first />
			<GroupNote>対応しているエージェントのタブを、この端末でどちらの表示で開くかを決めます。タブを長押しすればいつでも切り替えられます。</GroupNote>
			<ListGroup>
				{OPTIONS.map(option => (
					<ListRow
						key={option.value}
						label={option.label}
						hint={option.hint}
						trailing={view === option.value ? 'check' : 'none'}
						selected={view === option.value}
						onPress={() => choose(option.value)}
					/>
				))}
			</ListGroup>
		</SettingsScreen>
	);
}
