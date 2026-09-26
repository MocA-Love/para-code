// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Monitor, Server } from 'lucide-react-native';
import { useRelayHostSelection } from '../../hooks/useRelayHostSelection.js';
import type { RelayHost } from '../../relayHosts.js';
import { colors, space, type } from '../../theme.js';
import { ListGroup, ListRow, PickerDrawer } from '../../ui/index.js';

/**
 * 使用量の画面で「どの接続先（ローカル / SSH のリモート）の数字か」を選ぶ（旧 `HostSegment` の作り直し）。
 * 接続先が1つしか無い（SSH のウィンドウを開いていない）ときは何も出さない。
 *
 * 選んだ接続先はストア（`selectedHostId`）に残るので、使用量のまとめから開いた各詳細も同じ接続先の値を出す。
 */
export interface UsageHostState {
	readonly hosts: RelayHost[];
	readonly effectiveHostId: string | undefined;
	readonly selectedHost: RelayHost | undefined;
	/** 接続先を選べる状態で、選んだ接続先が消えた・応答していない（取得を止め、直近の値を薄く残す）。 */
	readonly stale: boolean;
	/** 値を接続先ごとに持つときの鍵（接続先が1つも定まらない旧 PC では `default`）。 */
	readonly key: string;
	readonly selectHost: (id: string) => void;
}

export function useUsageHost(): UsageHostState {
	const { hosts, effectiveHostId, selectHost } = useRelayHostSelection();
	const selectedHost = hosts.find(host => host.id === effectiveHostId);
	return {
		hosts,
		effectiveHostId,
		selectedHost,
		stale: hosts.length > 0 && selectedHost?.ready !== true,
		key: effectiveHostId ?? 'default',
		selectHost,
	};
}

/** 接続先を選ぶ行（2つ以上あるときだけ）と、応答しない接続先の注意書き。 */
export function UsageHostPicker({ host }: { host: UsageHostState }) {
	const [open, setOpen] = useState(false);
	if (host.hosts.length <= 1) {
		return null;
	}
	const current = host.selectedHost;
	return (
		<>
			<ListGroup style={styles.group}>
				<ListRow
					icon={current?.kind === 'remote' ? Server : Monitor}
					label="接続先"
					value={current !== undefined ? `${current.label}${current.ready ? '' : '（オフライン）'}` : '選ばれていません'}
					trailing="chevron"
					onPress={() => setOpen(true)}
				/>
			</ListGroup>
			{host.stale ? (
				<Text style={styles.warn}>
					{current === undefined
						? 'この接続先のウィンドウは閉じられました。別の接続先を選んでください。'
						: 'この接続先の PC の画面はいま応答していません。PC でウィンドウを開き直すと取得し直せます。'}
				</Text>
			) : null}
			<PickerDrawer
				visible={open}
				title="接続先"
				options={host.hosts.map(item => ({
					value: item.id,
					label: item.label,
					hint: item.ready ? (item.kind === 'remote' ? 'SSH のリモート' : 'この PC') : 'オフライン',
					icon: item.kind === 'remote' ? Server : Monitor,
				}))}
				selected={host.effectiveHostId}
				onSelect={host.selectHost}
				onClose={() => setOpen(false)}
			/>
		</>
	);
}

const styles = StyleSheet.create({
	group: {
		marginBottom: space.xl,
	},
	warn: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.amber,
		marginTop: -space.lg,
		marginBottom: space.xl,
		marginHorizontal: space.xs,
	},
});
