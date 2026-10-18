import {
  type ExternalCliBinaryResolution,
  type ExternalCliTeamProviderId,
  getExternalCliProviderSpec,
  isExternalCliTeamProviderId,
  resolveExternalCliBinary,
} from '@main/services/team/runtime/externalCli';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderId, CliProviderStatus } from '@shared/types/cliInstaller';

const RESOLUTION_CACHE_TTL_MS = 60_000;
const STATUS_PROBE_TIMEOUT_MS = 3_000;

interface CachedResolution {
  at: number;
  resolution: ExternalCliBinaryResolution;
}

const resolutionCache = new Map<ExternalCliTeamProviderId, CachedResolution>();
const inFlightResolutions = new Map<
  ExternalCliTeamProviderId,
  Promise<ExternalCliBinaryResolution>
>();

export function invalidateExternalCliProviderStatusCache(): void {
  resolutionCache.clear();
}

export async function resolveExternalCliProviderStatusBinary(
  providerId: ExternalCliTeamProviderId,
  options: { force?: boolean } = {}
): Promise<ExternalCliBinaryResolution> {
  if (!options.force) {
    const cached = resolutionCache.get(providerId);
    if (cached && Date.now() - cached.at < RESOLUTION_CACHE_TTL_MS) {
      return cached.resolution;
    }
  }
  const inFlight = inFlightResolutions.get(providerId);
  if (inFlight) {
    return inFlight;
  }
  const resolutionPromise = resolveExternalCliBinary(providerId, {
    skipVersionProbe: true,
    timeoutMs: STATUS_PROBE_TIMEOUT_MS,
  })
    .then((resolution) => {
      resolutionCache.set(providerId, { at: Date.now(), resolution });
      return resolution;
    })
    .finally(() => {
      inFlightResolutions.delete(providerId);
    });
  inFlightResolutions.set(providerId, resolutionPromise);
  return resolutionPromise;
}

export function buildExternalCliProviderStatus(
  providerId: CliProviderId,
  resolution: ExternalCliBinaryResolution
): CliProviderStatus {
  const spec = getExternalCliProviderSpec(resolution.providerId);
  return {
    providerId,
    displayName: spec.displayName,
    supported: resolution.ok,
    authenticated: resolution.ok,
    authMethod: resolution.ok ? 'external-cli' : null,
    verificationState: resolution.ok ? 'verified' : 'unknown',
    statusCheckOutcome: 'authoritative',
    statusMessage: resolution.ok
      ? `${spec.displayName} CLI detected at ${resolution.binaryPath}`
      : resolution.reason,
    detailMessage: resolution.ok
      ? spec.authHint
      : `${resolution.installHint} ${resolution.authHint}`.trim(),
    models: [],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: resolution.ok,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
  };
}

export async function buildExternalCliProviderStatusFor(
  providerId: CliProviderId,
  options: { force?: boolean } = {}
): Promise<CliProviderStatus | null> {
  if (!isExternalCliTeamProviderId(providerId)) {
    return null;
  }
  const resolution = await resolveExternalCliProviderStatusBinary(providerId, options);
  return buildExternalCliProviderStatus(providerId, resolution);
}

export async function buildExternalCliProviderStatuses(
  providerIds: readonly CliProviderId[],
  options: { force?: boolean } = {}
): Promise<CliProviderStatus[]> {
  const statuses: CliProviderStatus[] = [];
  for (const providerId of providerIds) {
    const status = await buildExternalCliProviderStatusFor(providerId, options);
    if (status) {
      statuses.push(status);
    }
  }
  return statuses;
}

export function mergeExternalCliProviderStatuses(
  providers: readonly CliProviderStatus[],
  externalStatuses: readonly CliProviderStatus[]
): CliProviderStatus[] {
  if (externalStatuses.length === 0) {
    return [...providers];
  }
  const externalById = new Map(externalStatuses.map((status) => [status.providerId, status]));
  const merged = providers.map((provider) => externalById.get(provider.providerId) ?? provider);
  const existingIds = new Set(providers.map((provider) => provider.providerId));
  for (const status of externalStatuses) {
    if (!existingIds.has(status.providerId)) {
      merged.push(status);
    }
  }
  return merged;
}
