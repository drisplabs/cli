/**
 * `ConsoleBrokerClient` — adapter-local WS wrapper. Full implementation
 * lands in Task K2. This file currently exposes only the public type so
 * the rest of the K1 skeleton can compile.
 */

import type {
	AthenaConsoleFrame,
	AthenaConsoleReadyFrame,
} from '../../../shared/gateway-protocol';

export type ConsoleHelloPayload = {
	runnerId: string;
	clientName: string;
	clientVersion: string;
};

export type ConsoleBrokerClient = {
	connect(hello: ConsoleHelloPayload): Promise<void>;
	close(reason: string): void;
	sendFrame(frame: AthenaConsoleFrame): void;
	onFrame(handler: (frame: AthenaConsoleFrame) => void): void;
	onReady(handler: (address: AthenaConsoleReadyFrame['address']) => void): void;
	onClose(handler: (reason: string) => void): void;
	getReadyAddress(): AthenaConsoleReadyFrame['address'] | null;
	isReady(): boolean;
};
