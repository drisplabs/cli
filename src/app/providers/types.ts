/**
 * React context types.
 *
 * Types for React context providers in the application.
 */

import {type ReactNode} from 'react';
import {type UseFeedResult} from './useFeed';
import type {Runtime} from '../../core/runtime/types';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {RuntimeFactory} from '../runtime/createRuntime';
import type {ChannelDefinition} from '../../channels/types';

/**
 * Value provided by the HookContext.
 */
export type HookContextValue = UseFeedResult;

/**
 * Props for the HookProvider component.
 */
export type HookProviderProps = {
	projectDir: string;
	instanceId: number;
	harness: AthenaHarness;
	workflow?: WorkflowConfig;
	runtime?: Runtime;
	runtimeFactory?: RuntimeFactory;
	allowedTools?: string[];
	athenaSessionId: string;
	/**
	 * Resolved channel definitions to attach to this session. Empty or
	 * omitted means the channels subsystem is inactive (no relay, no
	 * subprocess spawn). The list must already be resolved (sidecars
	 * loaded, entry paths verified) — see app/channels/setup.ts.
	 *
	 * STABILITY: callers MUST pass a referentially stable array across
	 * renders (resolve once at startup). A fresh array literal on each
	 * render will tear down and respawn channel subprocesses.
	 */
	channels?: ChannelDefinition[];
	children: ReactNode;
};
