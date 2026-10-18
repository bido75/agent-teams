import {
  type ExternalCliBinaryResolution,
  type ExternalCliTeamProviderId,
  getExternalCliProviderSpec,
  isExternalCliTeamProviderId,
  resolveExternalCliBinary,
  resolveExternalCliModelCatalog,
} from '@main/services/team/runtime/externalCli';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderId, CliProviderStatus } from '@shared/types/cliInstaller';

const RESOLUTION_CACHE_TTL_MS = 60_000;
const STATUS_PROBE_TIMEOUT_MS = 3_000;

interface CachedResolution {
  at: number;
  resolution: ExternalCliBinaryResolution;
  catalog: CliProviderStatus['modelCatalog'];
}

const resolutionCache = new Map<ExternalCliTeamProviderId, CachedResolution>();
const inFlightResolutions = new Map<
  ExternalCliTeamProviderId,
  Promise<{
    resolution: ExternalCliBinaryResolution;
    catalog: CliProviderStatus['modelCatalog'];
  }>
>();

export function invalidateExternalCliProviderStatusCache(): void {
  resolutionCache.clear();
}

export async function resolveExternalCliProviderStatusBinary(
  providerId: ExternalCliTeamProviderId,
  options: { force?: boolean } = {}
): Promise<{
  resolution: ExternalCliBinaryResolution;
  catalog: CliProviderStatus['modelCatalog'];
}> {
  if (!options.force) {
    const cached = resolutionCache.get(providerId);
    if (cached && Date.now() - cached.at < RESOLUTION_CACHE_TTL_MS) {
      return { resolution: cached.resolution, catalog: cached.catalog };
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
    .then(async (resolution) => {
      const catalog = resolution.ok
        ? await resolveExternalCliModelCatalog(providerId, resolution.binaryPath ?? null).catch(
            () => null
          )
        : null;
      resolutionCache.set(providerId, { at: Date.now(), resolution, catalog });
      return { resolution, catalog };
    })
    .finally(() => {
      inFlightResolutions.delete(providerId);
    });
  inFlightResolutions.set(providerId, resolutionPromise);
  return resolutionPromise;
}

export function buildExternalCliProviderStatus(
  providerId: CliProviderId,
  resolution: ExternalCliBinaryResolution,
  modelCatalog: CliProviderStatus['modelCatalog'] = null
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
    models: modelCatalog?.models.map((model) => model.launchModel) ?? [],
    modelAvailability: [],
    modelCatalog,
    modelCatalogRefreshState: modelCatalog ? 'ready' : undefined,
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
  const { resolution, catalog } = await resolveExternalCliProviderStatusBinary(providerId, options);
  return buildExternalCliProviderStatus(providerId, resolution, catalog);
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
