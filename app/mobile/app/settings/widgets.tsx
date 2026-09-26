// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ArrowDown, ArrowUp } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { hapticSelection } from '../../src/haptics.js';
import { useParaToast } from '../../src/paraToast.js';
import { space } from '../../src/theme.js';
import { Card, HeaderButton, ListGroup, ListRow, PickerDrawer, themeColorOf, useThemeColorStore, type PickerOption } from '../../src/ui/index.js';
import { GroupHeader, GroupNote, SettingsScreen, SettingsSwitch } from '../../src/features/settings/settingsScaffold.js';
import { samplePc, WIDGET_DESIGN_LABELS, WIDGET_SIZE_LABELS, type WidgetDesign, type WidgetPreviewSize } from '../../src/features/widgets/previewModel.js';
import { SegmentChips } from '../../src/features/widgets/segmentChips.js';
import { WidgetPreview } from '../../src/features/widgets/widgetPreview.js';
import {
	moveMetric,
	resolveWidgetAccentHex,
	toggleAgentFilter,
	toggleMetric,
	WIDGET_ACCENT_LABELS,
	WIDGET_ACCENTS,
	WIDGET_AGENT_FILTER_LABELS,
	WIDGET_AGENT_FILTERS,
	WIDGET_AGENTS_LIMIT_MAX,
	WIDGET_AGENTS_LIMIT_MIN,
	WIDGET_AGENTS_ORDER_LABELS,
	WIDGET_ATTENTION_ORDER_LABELS,
	WIDGET_FRESHNESS_LABELS,
	WIDGET_PC_METRIC_LABELS,
	WIDGET_PC_METRICS,
	type WidgetAccent,
	type WidgetAgentsOrder,
	type WidgetAttentionOrder,
	type WidgetFreshness,
	type WidgetSettings,
} from '../../src/widgets/settings.js';
import { updateWidgetSettings, useWidgetSettings } from '../../src/widgets/widgetSettingsStore.js';

type Picker = 'accent' | 'freshness' | 'attentionOrder' | 'agentsOrder' | 'agentsLimit' | 'defaultSpace';

const DESIGN_OPTIONS = (Object.keys(WIDGET_DESIGN_LABELS) as WidgetDesign[]).map(value => ({ value, label: WIDGET_DESIGN_LABELS[value] }));
const SIZE_OPTIONS = (Object.keys(WIDGET_SIZE_LABELS) as WidgetPreviewSize[]).map(value => ({ value, label: WIDGET_SIZE_LABELS[value] }));
/** 「指定しない」を表す既定のスペースの値。 */
const NO_SPACE = '';

function showSaveFailed(): void {
	useParaToast.getState().show({ key: 'widget-settings-save', text: '保存できませんでした', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
}

/**
 * 設定 → ウィジェット（`/settings/widgets`）。ホーム画面・ロック画面のウィジェットの見た目と表示項目を選ぶ。
 * 上に選んだ内容で描いた見本（架空のデータ）を出す。変えるとすぐ App Group へ書き、ウィジェットを描き直させる。
 *
 * ウィジェットを長押し →「ウィジェットを編集」で選べる項目（PC・スペース・質問文・並び順・利用上限）は
 * ウィジェット側が優先で、ここの値はウィジェット側で「既定」にしたときに使われる。
 */
export default function WidgetSettingsScreen() {
	const settings = useWidgetSettings(s => s.settings);
	const primary = useThemeColorStore(s => themeColorOf(s.settings, 'primary'));
	const { workspaces, activePcId } = useAppStore(useShallow(s => ({ workspaces: s.workspace?.workspaces, activePcId: s.activePcId })));
	const [design, setDesign] = useState<WidgetDesign>('attention');
	const [size, setSize] = useState<WidgetPreviewSize>('medium');
	const [picker, setPicker] = useState<Picker | undefined>(undefined);
	const [now] = useState(() => Date.now());
	const [pc] = useState(() => samplePc(now));

	const update = (next: WidgetSettings) => {
		updateWidgetSettings(next).catch(showSaveFailed);
	};
	const open = (next: Picker) => {
		hapticSelection();
		setPicker(next);
	};

	const spaceOptions: PickerOption[] = [
		{ value: NO_SPACE, label: '指定しない', hint: 'エージェントのいるスペースを出します' },
		...(workspaces ?? []).map(workspace => ({ value: workspace.id, label: workspace.name })),
	];
	const defaultSpace = settings.space.defaultSpace;
	const defaultSpaceName = defaultSpace === undefined
		? '指定しない'
		: defaultSpace.pcId === activePcId
			? workspaces?.find(workspace => workspace.id === defaultSpace.spaceId)?.name ?? '見つからないスペース'
			: 'ほかの PC のスペース';

	const pickerProps = pickerFor(picker, settings, spaceOptions, activePcId, update);

	return (
		<SettingsScreen
			title="ウィジェット"
			footer={(
				<PickerDrawer
					visible={picker !== undefined}
					title={pickerProps.title}
					options={pickerProps.options}
					selected={pickerProps.selected}
					onSelect={pickerProps.onSelect}
					onClose={() => setPicker(undefined)}
				/>
			)}
		>
			<GroupHeader title="プレビュー" first />
			<Card style={styles.previewCard}>
				<SegmentChips options={DESIGN_OPTIONS} selected={design} onSelect={setDesign} accessibilityLabel="ウィジェットの種類" />
				<View style={styles.gap} />
				<SegmentChips options={SIZE_OPTIONS} selected={size} onSelect={setSize} accessibilityLabel="ウィジェットの大きさ" />
				<WidgetPreview design={design} size={size} settings={settings} pc={pc} now={now} />
			</Card>
			<GroupNote after>見本のデータで描いた近似です。ウィジェットを長押しして「ウィジェットを編集」で PC やスペースを選んだ項目は、そちらが優先されます。</GroupNote>

			<GroupHeader title="共通" />
			<ListGroup>
				<ListRow label="アクセントの色" hint="許可ボタンなどの色" value={WIDGET_ACCENT_LABELS[settings.accent]} trailing="chevron" onPress={() => open('accent')} />
				<ListRow
					label="名前を表示"
					hint="エージェント名とスペース名。オフにすると種類だけを出します"
					trailing={<SettingsSwitch value={settings.showNames} onValueChange={value => update({ ...settings, showNames: value })} accessibilityLabel="名前を表示" />}
				/>
				<ListRow
					label="質問文とコマンドを表示"
					hint="オフのときはウィジェットに渡しません"
					trailing={<SettingsSwitch value={settings.showDetail} onValueChange={value => update({ ...settings, showDetail: value })} accessibilityLabel="質問文とコマンドを表示" />}
				/>
				<ListRow label="「◯分前の状態」" value={WIDGET_FRESHNESS_LABELS[settings.freshness]} trailing="chevron" onPress={() => open('freshness')} />
			</ListGroup>
			<GroupNote after>ロック画面では、名前と質問文は iPhone の設定（ロック中にアクセスを許可）に従って隠れます。PC がオフラインのときは「◯分前」を必ず出します。</GroupNote>

			<GroupHeader title="要対応" />
			<ListGroup>
				<ListRow label="並び順" value={WIDGET_ATTENTION_ORDER_LABELS[settings.attention.order]} trailing="chevron" onPress={() => open('attentionOrder')} />
				<ListRow label="「許可」ボタン" hint="押すとアプリの許可カードを開きます" trailing={<SettingsSwitch value={settings.attention.showApprove} onValueChange={value => update({ ...settings, attention: { ...settings.attention, showApprove: value } })} accessibilityLabel="許可ボタン" />} />
				<ListRow label="「答える」ボタン" hint="押すとアプリの質問を開きます" trailing={<SettingsSwitch value={settings.attention.showAnswer} onValueChange={value => update({ ...settings, attention: { ...settings.attention, showAnswer: value } })} accessibilityLabel="答えるボタン" />} />
				<ListRow label="「確認済み」ボタン" hint="ウィジェットの中で確認済みにします" trailing={<SettingsSwitch value={settings.attention.showReview} onValueChange={value => update({ ...settings, attention: { ...settings.attention, showReview: value } })} accessibilityLabel="確認済みボタン" />} />
			</ListGroup>

			<GroupHeader title="エージェント" />
			<ListGroup>
				{WIDGET_AGENT_FILTERS.map(filter => (
					<ListRow
						key={filter}
						label={`${WIDGET_AGENT_FILTER_LABELS[filter]}を出す`}
						trailing={(
							<SettingsSwitch
								value={settings.agents.states.includes(filter)}
								disabled={settings.agents.states.length === 1 && settings.agents.states.includes(filter)}
								onValueChange={() => update({ ...settings, agents: { ...settings.agents, states: toggleAgentFilter(settings.agents.states, filter) } })}
								accessibilityLabel={`${WIDGET_AGENT_FILTER_LABELS[filter]}を出す`}
							/>
						)}
					/>
				))}
				<ListRow label="並び順" value={WIDGET_AGENTS_ORDER_LABELS[settings.agents.order]} trailing="chevron" onPress={() => open('agentsOrder')} />
				<ListRow label="大サイズの行数" value={`${settings.agents.limit} 行`} trailing="chevron" onPress={() => open('agentsLimit')} />
			</ListGroup>

			<GroupHeader title="PC の状態" />
			<GroupNote>出す指標と並び。小サイズは上から 4 つを出します。</GroupNote>
			<ListGroup>
				{orderedMetrics(settings).map(metric => {
					const shown = settings.pc.metrics.includes(metric);
					const index = settings.pc.metrics.indexOf(metric);
					return (
						<ListRow
							key={metric}
							label={WIDGET_PC_METRIC_LABELS[metric]}
							trailing={(
								<View style={styles.metricTrailing}>
									{shown ? (
										<>
											<HeaderButton icon={ArrowUp} label={`${WIDGET_PC_METRIC_LABELS[metric]}を上へ`} disabled={index <= 0} onPress={() => update({ ...settings, pc: { metrics: moveMetric(settings.pc.metrics, metric, -1) } })} />
											<HeaderButton icon={ArrowDown} label={`${WIDGET_PC_METRIC_LABELS[metric]}を下へ`} disabled={index >= settings.pc.metrics.length - 1} onPress={() => update({ ...settings, pc: { metrics: moveMetric(settings.pc.metrics, metric, 1) } })} />
										</>
									) : null}
									<SettingsSwitch value={shown} onValueChange={() => update({ ...settings, pc: { metrics: toggleMetric(settings.pc.metrics, metric) } })} accessibilityLabel={`${WIDGET_PC_METRIC_LABELS[metric]}を出す`} />
								</View>
							)}
						/>
					);
				})}
			</ListGroup>

			<GroupHeader title="スペース" />
			<ListGroup>
				<ListRow label="既定のスペース" hint="ウィジェット側でスペースを選んでいないときに出します" value={defaultSpaceName} trailing="chevron" onPress={() => open('defaultSpace')} />
				<ListRow label="エージェントを出す" trailing={<SettingsSwitch value={settings.space.showAgents} onValueChange={value => update({ ...settings, space: { ...settings.space, showAgents: value } })} accessibilityLabel="エージェントを出す" />} />
				<ListRow label="変更件数を出す" trailing={<SettingsSwitch value={settings.space.showChanges} onValueChange={value => update({ ...settings, space: { ...settings.space, showChanges: value } })} accessibilityLabel="変更件数を出す" />} />
				<ListRow label="最新のコミットを出す" trailing={<SettingsSwitch value={settings.space.showCommits} onValueChange={value => update({ ...settings, space: { ...settings.space, showCommits: value } })} accessibilityLabel="最新のコミットを出す" />} />
			</ListGroup>
			<GroupNote after>
				ホーム画面の空いているところを長押し → 左上の「編集」→「ウィジェットを追加」→ Para Code から追加します。
				アクセントの色は{resolveWidgetAccentHex(settings.accent, primary) === undefined ? '文字色' : '選んだ色'}で描きます。ティント・クリアの外観では OS が色を決めます。
			</GroupNote>
		</SettingsScreen>
	);
}

/** 出している指標を設定の並びで先に、出していないものを既定の並びで後ろに。 */
function orderedMetrics(settings: WidgetSettings) {
	return [...settings.pc.metrics, ...WIDGET_PC_METRICS.filter(metric => !settings.pc.metrics.includes(metric))];
}

function pickerFor(
	picker: Picker | undefined,
	settings: WidgetSettings,
	spaceOptions: PickerOption[],
	activePcId: string | undefined,
	update: (next: WidgetSettings) => void,
): { title: string | undefined; options: readonly PickerOption[]; selected: string | undefined; onSelect: (value: string) => void } {
	switch (picker) {
		case 'accent':
			return {
				title: 'アクセントの色',
				options: WIDGET_ACCENTS.map(value => ({ value, label: WIDGET_ACCENT_LABELS[value] })),
				selected: settings.accent,
				onSelect: value => update({ ...settings, accent: value as WidgetAccent }),
			};
		case 'freshness':
			return {
				title: '「◯分前の状態」',
				options: (Object.keys(WIDGET_FRESHNESS_LABELS) as WidgetFreshness[]).map(value => ({ value, label: WIDGET_FRESHNESS_LABELS[value] })),
				selected: settings.freshness,
				onSelect: value => update({ ...settings, freshness: value as WidgetFreshness }),
			};
		case 'attentionOrder':
			return {
				title: '要対応の並び順',
				options: (Object.keys(WIDGET_ATTENTION_ORDER_LABELS) as WidgetAttentionOrder[]).map(value => ({ value, label: WIDGET_ATTENTION_ORDER_LABELS[value] })),
				selected: settings.attention.order,
				onSelect: value => update({ ...settings, attention: { ...settings.attention, order: value as WidgetAttentionOrder } }),
			};
		case 'agentsOrder':
			return {
				title: 'エージェントの並び順',
				options: (Object.keys(WIDGET_AGENTS_ORDER_LABELS) as WidgetAgentsOrder[]).map(value => ({ value, label: WIDGET_AGENTS_ORDER_LABELS[value] })),
				selected: settings.agents.order,
				onSelect: value => update({ ...settings, agents: { ...settings.agents, order: value as WidgetAgentsOrder } }),
			};
		case 'agentsLimit': {
			const values: string[] = [];
			for (let n = WIDGET_AGENTS_LIMIT_MIN; n <= WIDGET_AGENTS_LIMIT_MAX; n++) {
				values.push(String(n));
			}
			return {
				title: '大サイズの行数',
				options: values.map(value => ({ value, label: `${value} 行` })),
				selected: String(settings.agents.limit),
				onSelect: value => update({ ...settings, agents: { ...settings.agents, limit: Number(value) } }),
			};
		}
		case 'defaultSpace': {
			const current = settings.space.defaultSpace;
			return {
				title: '既定のスペース',
				options: spaceOptions,
				selected: current === undefined ? NO_SPACE : current.pcId === activePcId ? current.spaceId : undefined,
				onSelect: value => {
					const { defaultSpace: _removed, ...rest } = settings.space;
					update({ ...settings, space: value === NO_SPACE || activePcId === undefined ? rest : { ...rest, defaultSpace: { pcId: activePcId, spaceId: value } } });
				},
			};
		}
		default:
			return { title: undefined, options: [], selected: undefined, onSelect: () => undefined };
	}
}

const styles = StyleSheet.create({
	previewCard: {
		padding: space.md,
	},
	gap: {
		height: space.sm,
	},
	metricTrailing: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
});
