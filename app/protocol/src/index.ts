// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export { generateIdentity, createInitiator, respondHandshake, randomToken, SecureChannel } from './crypto.js';
export type { Identity, InitiatorHandshake, ResponderHandshake } from './crypto.js';
export { encodePairingUri, decodePairingUri, deriveSasCode, PAIRING_URI_SCHEME } from './pairing.js';
export type { PairingPayload } from './pairing.js';
export { Channels, encodeFrame, decodeFrame } from './frames.js';
export type { ChannelId, Frame } from './frames.js';
export { FrameMux } from './mux.js';
export type { FrameHandler, FrameMuxOptions } from './mux.js';
export { toBase64Url, fromBase64Url, concatBytes, bytesEqual } from './util.js';
export { RELAY_DATA_VERSION, MOBILE_ID_LENGTH, packPcData, unpackPcData, mobileIdToString, mobileIdFromString, encodeRelayControl, decodeRelayControl } from './relay.js';
export type { RelayControlMessage } from './relay.js';
export { encodeNotify, decodeNotify } from './notify.js';
export type { NotifyKind, NotifyPayload } from './notify.js';
