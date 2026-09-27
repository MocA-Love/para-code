// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, Folder, Plus, Shield, SquareTerminal } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../appState.js';
import { launchAgentInBackground } from '../../agentLaunch.js';
import { ProviderLogo } from '../../components/providerLogo.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { useParaToast } from '../../paraToast.js';
import { routes } from '../../routes.js';
import type { WorktreeFormResult } from '../../store.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { BottomDrawer, Button, DrawerTitle, Icon, PickerDrawer, iconSize, useThemeColors, type PickerOption } from '../../ui/index.js';
import { spaceColor } from '../pc/spaceColor.js';
import {
	TERMINAL_KIND,
	defaultLaunchTarget,
	encodeLaunchTarget,
	launchBlockedReason,
	launchSpaceOptions,
	launchableAgents,
	parseLaunchTarget,
	pcSupportsLaunchIntoSpace,
	type LaunchTarget,
} from './launchForm.js';
import { resetDetailColumnFor } from '../../ipad/detailColumn.js';

type Sheet = 'form' | 'space' | 'kind' | 'permission';

const NO_SPACES: readonly { readonly id: string; readonly name: string; readonly branch?: string; readonly color?: string; readonly parent?: string }[] = [];

/** 起動先の指定（開いたときの既定）。 */
export type LaunchPreset = { readonly kind: 'space'; readonly spaceId: string } | { readonly kind: 'newSpace' };

/**
 * 「エージェントを起動」のシート（モックの `sheet:launch`、Orca の Create worktree シート）。
 * 欄はスペース・名前（新しいスペースのとき）・起動するもの（Claude / Codex / ターミナル）・最初の指示・
 * 詳細（権限）。選択肢はそれぞれ下から出るシート（PickerDrawer）で選び、選ぶとこのシートへ戻る。
 *
 * 起動は既存の処理を使う:
 *  - エージェント → `launchAgentInBackground`（既存スペースは launchAgent、新しいスペースは createWorktree）
 *  - ターミナル → 既存スペースは `createTerminal`、新しいスペースは `createWorktree`（エージェントなし）
 *
 * 既存のスペースへ起動したときは、閉じ切ったあとにそのスペースのセッションへ入る。
 * 開いている PC（`activePcId`）に対して起動する（呼び出し側はその PC の画面かホームから開く）。
 */
export function LaunchDrawer({ visible, preset, onClose }: {
	visible: boolean;
	/** 開いたときの既定の起動先。省略すると PC で開いているスペース。 */
	preset?: LaunchPreset;
	/** シートが閉じ切ったあとに呼ぶ。親は `visible` を false にする。 */
	onClose: () => void;
}) {
	const router = useRouter();
	// **`s.workspace` 本体は購読しない**（このシートは閉じていても木に残るので、PC からの再送のたびに
	// 描き直すことになる）。スペースの並びは中身が同じなら参照が据え置かれる（workspaceIdentity.ts）。
	const { pcId, worktreeForm, createTerminal, createWorktree, live } = useAppStore(useShallow(s => ({
		pcId: s.activePcId,
		worktreeForm: s.worktreeForm,
		createTerminal: s.createTerminal,
		createWorktree: s.createWorktree,
		live: s.connection === 'online' && s.pcOnline && s.sessionProtocolReady && s.workspace?.renderers.some(renderer => renderer.ready) === true,
	})));
	const spaces = useAppStore(s => s.workspace?.workspaces) ?? NO_SPACES;
	const activeWs = useAppStore(s => s.workspace?.activeWs);

	const theme = useThemeColors();
	const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
	const next = useRef<Sheet | 'launched' | undefined>(undefined);
	const launchedSpace = useRef<string | undefined>(undefined);
	const [form, setForm] = useState<{ readonly pcId: string | undefined; readonly result: WorktreeFormResult } | undefined>(undefined);
	const [formError, setFormError] = useState<string | undefined>(undefined);
	const [kind, setKind] = useState<string | undefined>(undefined);
	const [targetValue, setTargetValue] = useState<string | undefined>(undefined);
	const [name, setName] = useState('');
	const [prompt, setPrompt] = useState('');
	const [permission, setPermission] = useState<string | undefined>(undefined);
	const [advanced, setAdvanced] = useState(false);
	const [wasVisible, setWasVisible] = useState(false);
	const presetRef = useRef(preset);
	presetRef.current = preset;

	const formResult = form !== undefined && form.pcId === pcId ? form.result : undefined;
	const agents = launchableAgents(formResult);
	const repos = formResult?.repos ?? [];

	// 開いた瞬間に前回の入力を捨てる（描画の前に済ませ、古い値を1フレームも見せない）。
	if (visible !== wasVisible) {
		setWasVisible(visible);
		if (visible) {
			setSheet('form');
			next.current = undefined;
			launchedSpace.current = undefined;
			setName('');
			setPrompt('');
			setAdvanced(false);
			setFormError(undefined);
			const presetTarget: LaunchTarget | undefined = preset?.kind === 'space' ? { kind: 'space', spaceId: preset.spaceId } : undefined;
			const target = preset?.kind === 'newSpace'
				? (repos[0] !== undefined ? { kind: 'new' as const, repoId: repos[0].id } : undefined)
				: defaultLaunchTarget(presetTarget, spaces, repos, activeWs);
			setTargetValue(target !== undefined ? encodeLaunchTarget(target) : undefined);
			const firstAgent = agents.find(agent => agent.id === 'claude') ?? agents[0];
			setKind(firstAgent?.id ?? TERMINAL_KIND);
			setPermission(firstAgent?.permissions?.[0]?.id);
		} else {
			setSheet(undefined);
		}
	}

	// 起動フォームの材料（エージェント定義・リポジトリ一覧）を PC から取る。PC を切り替えたら取り直す。
	const needsForm = visible && live && formResult === undefined && formError === undefined;
	useEffect(() => {
		if (!needsForm) {
			return undefined;
		}
		let cancelled = false;
		const requestedFor = pcId;
		worktreeForm().then(result => {
			if (cancelled || useAppStore.getState().activePcId !== requestedFor) {
				return;
			}
			setForm({ pcId: requestedFor, result });
			const loadedAgents = launchableAgents(result);
			const firstAgent = loadedAgents.find(agent => agent.id === 'claude') ?? loadedAgents[0];
			// 開いたときにまだ材料が無かった分の既定を、届いた材料で埋める（利用者が選んだものは変えない）。
			setKind(current => (current === undefined || current === TERMINAL_KIND ? firstAgent?.id ?? TERMINAL_KIND : current));
			setPermission(current => current ?? firstAgent?.permissions?.[0]?.id);
			setTargetValue(current => {
				if (current !== undefined) {
					return current;
				}
				const repo = result.repos[0];
				const latest = useAppStore.getState().workspace;
				const fallback = presetRef.current?.kind === 'newSpace'
					? (repo !== undefined ? { kind: 'new' as const, repoId: repo.id } : undefined)
					: defaultLaunchTarget(undefined, latest?.workspaces ?? [], result.repos, latest?.activeWs);
				return fallback !== undefined ? encodeLaunchTarget(fallback) : undefined;
			});
		}).catch((error: unknown) => {
			if (!cancelled) {
				setFormError(error instanceof Error ? error.message : String(error));
			}
		});
		return () => { cancelled = true; };
	}, [needsForm, pcId, worktreeForm]);

	const target = parseLaunchTarget(targetValue);
	const agent = agents.find(candidate => candidate.id === kind);
	const isTerminal = kind === TERMINAL_KIND;
	const selectedSpace = target?.kind === 'space' ? spaces.find(candidate => candidate.id === target.spaceId) : undefined;
	const selectedRepo = target?.kind === 'new' ? repos.find(repo => repo.id === target.repoId) : undefined;
	const selectedPermission = agent?.permissions?.find(candidate => candidate.id === permission);
	const blocked = launchBlockedReason({
		live,
		kind,
		// 選んだ起動先が消えた（PC 側で閉じられた）ときは選び直してもらう。
		target: selectedSpace !== undefined || selectedRepo !== undefined ? target : undefined,
		agents,
		supportsLaunchIntoSpace: pcSupportsLaunchIntoSpace(formResult),
	});

	const goTo = (sheetName: Sheet) => {
		hapticSelection();
		next.current = sheetName;
		setSheet(undefined);
	};
	const backToForm = () => {
		next.current = 'form';
		setSheet(undefined);
	};
	const afterClose = () => {
		const upcoming = next.current;
		next.current = undefined;
		if (upcoming === 'launched') {
			const spaceId = launchedSpace.current;
			launchedSpace.current = undefined;
			onClose();
			if (spaceId !== undefined && pcId !== undefined) {
				// 2列では詳細の列の中身を入れ替える。ホームから起動したときも PC の中の Stack の根を下に敷く。
				resetDetailColumnFor(pcId);
				router.push(routes.session(pcId, spaceId), { withAnchor: true });
			}
			return;
		}
		if (upcoming !== undefined) {
			setSheet(upcoming);
			return;
		}
		onClose();
	};

	const launch = () => {
		if (blocked !== undefined || target === undefined) {
			return;
		}
		hapticImpact('medium');
		const trimmedPrompt = prompt.trim();
		const trimmedName = name.trim();
		const permissionOption = selectedPermission !== undefined && selectedPermission.flag.length > 0 ? { permission: selectedPermission.id } : {};
		if (target.kind === 'space' && selectedSpace !== undefined) {
			if (isTerminal) {
				createTerminal(selectedSpace.id);
			} else if (agent !== undefined) {
				launchAgentInBackground({
					agentLabel: agent.label,
					subtitle: selectedSpace.branch !== undefined ? `${selectedSpace.name} · ${selectedSpace.branch}` : selectedSpace.name,
					agent: agent.id,
					prompt: trimmedPrompt,
					ws: selectedSpace.id,
					...permissionOption,
				});
			}
			launchedSpace.current = selectedSpace.id;
		} else if (target.kind === 'new' && selectedRepo !== undefined) {
			const newSpace = {
				repo: selectedRepo.id,
				name: trimmedName,
				...(selectedRepo.head !== undefined ? { base: selectedRepo.head } : {}),
				...(selectedRepo.setupScript !== undefined ? { runSetup: true } : {}),
			};
			if (isTerminal) {
				createNewSpace(createWorktree, newSpace, trimmedName || selectedRepo.name);
			} else if (agent !== undefined) {
				launchAgentInBackground({
					agentLabel: agent.label,
					subtitle: trimmedName || selectedRepo.name,
					agent: agent.id,
					prompt: trimmedPrompt,
					...permissionOption,
					newSpace,
				});
			}
		}
		next.current = 'launched';
		setSheet(undefined);
	};

	const spaceOptions: PickerOption[] = launchSpaceOptions(spaces, repos).map(option => ({
		value: option.value,
		label: option.label,
		...(option.hint !== undefined ? { hint: option.hint } : {}),
		leading: option.isNew
			? <Icon icon={Plus} size={iconSize.md} color={colors.textDim} />
			: <Icon icon={Folder} size={iconSize.md} color={spaceColor(spaces.find(candidate => candidate.id === option.spaceId) ?? { id: option.value })} />,
	}));
	const kindOptions: PickerOption[] = [
		...agents.map(candidate => ({
			value: candidate.id,
			label: candidate.label,
			hint: `${candidate.label} を起動します`,
			leading: <KindGlyph id={candidate.id} />,
		})),
		{ value: TERMINAL_KIND, label: 'ターミナル', hint: 'シェルだけを開きます', leading: <KindGlyph id={TERMINAL_KIND} /> },
	];
	const permissionOptions: PickerOption[] = (agent?.permissions ?? []).map(candidate => ({
		value: candidate.id,
		label: candidate.label,
		...(candidate.hint !== undefined ? { hint: candidate.hint } : {}),
		icon: Shield,
	}));
	const spaceLabel = selectedSpace?.name ?? (selectedRepo !== undefined ? `新しいスペース（${selectedRepo.name}）` : 'スペースを選ぶ');
	const kindLabel = isTerminal ? 'ターミナル' : agent?.label ?? '選ぶ';

	return (
		<>
			<BottomDrawer visible={sheet === 'form'} onClose={() => { next.current = undefined; setSheet(undefined); }} onAfterClose={afterClose} accessibilityLabel="エージェントを起動">
				<DrawerTitle title="エージェントを起動" />
				{formError !== undefined ? <Text style={styles.error}>{`起動フォームを読み込めませんでした: ${formError}`}</Text> : null}
				{formResult === undefined && formError === undefined && live ? <ActivityIndicator style={styles.loading} color={colors.textDim} /> : null}
				<Field label="スペース">
					<SelectButton
						label={spaceLabel}
						leading={selectedSpace !== undefined
							? <View style={[styles.spaceDot, { backgroundColor: spaceColor(selectedSpace) }]} />
							: <Icon icon={Plus} size={iconSize.md} color={colors.textDim} />}
						onPress={() => goTo('space')}
						disabled={spaceOptions.length === 0}
					/>
				</Field>
				{target?.kind === 'new' ? (
					<Field label="名前">
						<TextInput
							style={styles.input}
							value={name}
							onChangeText={setName}
							placeholder="例: fix/login（空欄なら自動で決めます）"
							placeholderTextColor={colors.textMuted}
							selectionColor={theme.accent}
							autoCapitalize="none"
							autoCorrect={false}
							keyboardAppearance="dark"
							accessibilityLabel="新しいスペースの名前"
						/>
					</Field>
				) : null}
				<Field label="起動するもの">
					<SelectButton label={kindLabel} leading={<KindGlyph id={kind ?? TERMINAL_KIND} />} onPress={() => goTo('kind')} />
				</Field>
				{!isTerminal ? (
					<Field label="最初の指示">
						<TextInput
							style={[styles.input, styles.prompt]}
							value={prompt}
							onChangeText={setPrompt}
							placeholder="例: ログイン画面のエラー表示を直して"
							placeholderTextColor={colors.textMuted}
							selectionColor={theme.accent}
							multiline
							textAlignVertical="top"
							keyboardAppearance="dark"
							accessibilityLabel="最初の指示"
						/>
					</Field>
				) : null}
				{!isTerminal && permissionOptions.length > 0 ? (
					<>
						<Pressable
							style={styles.advanced}
							onPress={() => { hapticSelection(); setAdvanced(open => !open); }}
							accessibilityRole="button"
							accessibilityState={{ expanded: advanced }}
						>
							<Text style={styles.advancedText}>詳細</Text>
							<Icon icon={advanced ? ChevronUp : ChevronDown} size={iconSize.sm} color={colors.textDim} />
						</Pressable>
						{advanced ? (
							<Field label="権限">
								<SelectButton
									label={selectedPermission?.label ?? '既定'}
									leading={<Icon icon={Shield} size={iconSize.md} color={selectedPermission?.danger === true ? colors.red : colors.textDim} />}
									onPress={() => goTo('permission')}
								/>
							</Field>
						) : null}
					</>
				) : null}
				<Button label="起動する" onPress={launch} disabled={blocked !== undefined} style={styles.create} />
				{blocked !== undefined ? <Text style={styles.blocked}>{blocked}</Text> : null}
			</BottomDrawer>
			<PickerDrawer
				visible={sheet === 'space'}
				title="スペース"
				options={spaceOptions}
				selected={targetValue}
				onSelect={setTargetValue}
				onClose={backToForm}
				onAfterClose={afterClose}
			/>
			<PickerDrawer
				visible={sheet === 'kind'}
				title="起動するもの"
				options={kindOptions}
				selected={kind}
				onSelect={value => {
					setKind(value);
					setPermission(agents.find(candidate => candidate.id === value)?.permissions?.[0]?.id);
				}}
				onClose={backToForm}
				onAfterClose={afterClose}
			/>
			<PickerDrawer
				visible={sheet === 'permission'}
				title="権限"
				options={permissionOptions}
				selected={permission}
				onSelect={setPermission}
				onClose={backToForm}
				onAfterClose={afterClose}
			/>
		</>
	);
}

/** 新しいスペースをエージェントなしで作る（ターミナルを選んだとき）。進行はトーストで伝える。 */
function createNewSpace(
	createWorktree: ReturnType<typeof useAppStore.getState>['createWorktree'],
	options: { repo: string; name: string; base?: string; runSetup?: boolean },
	label: string,
): void {
	const toast = useParaToast.getState();
	toast.show({ key: 'agent-launch', text: '新しいスペースを作成中…', sub: label, icon: 'sparkles-outline', tone: 'info', spinner: true });
	createWorktree({ repo: options.repo, ...(options.name.length > 0 ? { name: options.name } : {}), ...(options.base !== undefined ? { base: options.base } : {}), ...(options.runSetup !== undefined ? { runSetup: options.runSetup } : {}) })
		.then(result => {
			useParaToast.getState().show({ key: 'agent-launch', text: 'スペースを作成しました', sub: `${result.name} · ${result.branch}`, icon: 'checkmark-circle', tone: 'done' }, 2_500);
		})
		.catch((error: unknown) => {
			useParaToast.getState().show({ key: 'agent-launch', text: 'スペースを作成できませんでした', sub: error instanceof Error ? error.message : String(error), icon: 'alert-circle', tone: 'warn' }, 4_000);
		});
}

/** 起動するものの印（Claude / Codex のロゴ、ターミナルのアイコン）。 */
function KindGlyph({ id }: { id: string }) {
	if (id === 'claude' || id === 'codex') {
		return <ProviderLogo provider={id} size={iconSize.md} />;
	}
	return <Icon icon={id === TERMINAL_KIND ? SquareTerminal : Plus} size={iconSize.md} color={colors.textDim} />;
}

/** 欄の見出しと中身（モックの `.fl`）。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<View style={styles.field}>
			<Text style={styles.fieldLabel}>{label}</Text>
			{children}
		</View>
	);
}

/** 押すと選択肢のシートを開く欄（モックの `.fbtn`）。 */
function SelectButton({ label, leading, onPress, disabled = false }: { label: string; leading: ReactNode; onPress: () => void; disabled?: boolean }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.select, pressed ? styles.selectPressed : undefined, disabled ? styles.disabled : undefined]}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
		>
			{leading}
			<Text style={styles.selectText} numberOfLines={1}>{label}</Text>
			<Icon icon={ChevronDown} size={iconSize.sm} color={colors.textMuted} />
		</Pressable>
	);
}

/** モックの寸法（pt）。 */
const PROMPT_MIN_HEIGHT = 80;
const SPACE_DOT = 8;

const styles = StyleSheet.create({
	field: {
		marginBottom: space.md,
	},
	fieldLabel: {
		fontSize: type.label,
		fontWeight: '500',
		color: colors.textDim,
		marginBottom: space.xs,
	},
	select: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: HIT_SIZE,
		paddingHorizontal: space.md,
		borderRadius: radius.input,
		backgroundColor: colors.raised,
		borderWidth: 1,
		borderColor: colors.border,
	},
	selectPressed: {
		backgroundColor: colors.surface3,
	},
	selectText: {
		flex: 1,
		minWidth: 0,
		fontSize: type.body,
		color: colors.text,
	},
	spaceDot: {
		width: SPACE_DOT,
		height: SPACE_DOT,
		borderRadius: radius.pill,
	},
	input: {
		backgroundColor: colors.raised,
		color: colors.text,
		borderRadius: radius.input,
		borderWidth: 1,
		borderColor: colors.border,
		paddingHorizontal: space.md,
		paddingVertical: space.sm + 2,
		fontSize: type.input,
	},
	prompt: {
		minHeight: PROMPT_MIN_HEIGHT,
	},
	advanced: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minHeight: HIT_SIZE,
		marginBottom: space.xs,
	},
	advancedText: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.textDim,
	},
	create: {
		marginTop: space.xs,
	},
	blocked: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: space.sm,
		paddingHorizontal: space.xs,
	},
	error: {
		fontSize: type.meta,
		color: colors.red,
		marginBottom: space.md,
		paddingHorizontal: space.xs,
	},
	loading: {
		marginBottom: space.md,
	},
	disabled: {
		opacity: 0.45,
	},
});
