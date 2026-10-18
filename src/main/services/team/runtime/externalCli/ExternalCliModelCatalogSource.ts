import { execCli } from '@main/utils/childProcess';

import { getExternalCliProviderSpec } from './ExternalCliProviderSpecs';

import type { ExternalCliTeamProviderId } from './ExternalCliProviderSpecs';
import type {
  CliProviderModelCatalog,
  CliProviderModelCatalogItem,
  CliProviderModelCatalogSource,
} from '@shared/types/cliInstaller';

const RUNTIME_CATALOG_TIMEOUT_MS = 8_000;
const STATIC_FALLBACK_TTL_DAYS = 30;

interface ExternalCliModelSeed {
  id: string;
  label: string;
}

const STATIC_FALLBACK_MODELS: Record<ExternalCliTeamProviderId, readonly ExternalCliModelSeed[]> = {
  antigravity: [
    { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  ],
  minimax: [
    { id: 'MiniMax-M2', label: 'MiniMax M2' },
    { id: 'MiniMax-M2.1', label: 'MiniMax M2.1' },
  ],
  kimi: [
    { id: 'kimi-k2.5', label: 'Kimi K2.5' },
    { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo' },
  ],
  cline: [],
};

export function buildExternalCliModelCatalog(
  providerId: ExternalCliTeamProviderId,
  source: CliProviderModelCatalogSource,
  seeds: readonly ExternalCliModelSeed[],
  now: number = Date.now()
): CliProviderModelCatalog {
  const models: CliProviderModelCatalogItem[] = seeds.map((seed, index) => ({
    id: seed.id,
    launchModel: seed.id,
    displayName: seed.label,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: index === 0,
    upgrade: false,
    source,
    metadata: null,
  }));
  const first = models[0] ?? null;
  return {
    schemaVersion: 1,
    providerId,
    source,
    status: 'ready',
    fetchedAt: new Date(now).toISOString(),
    staleAt: new Date(now + STATIC_FALLBACK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    defaultModelId: first?.id ?? null,
    defaultLaunchModel: first?.launchModel ?? null,
    models,
    diagnostics: {
      configReadState: 'ready',
      appServerState: 'healthy',
    },
  };
}

export function buildExternalCliStaticModelCatalog(
  providerId: ExternalCliTeamProviderId,
  now: number = Date.now()
): CliProviderModelCatalog {
  return buildExternalCliModelCatalog(
    providerId,
    'static-fallback',
    STATIC_FALLBACK_MODELS[providerId],
    now
  );
}

export function parseAntigravityModelsOutput(stdout: string): ExternalCliModelSeed[] {
  const seeds: ExternalCliModelSeed[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.includes('\t')) {
      continue;
    }
    const [id, label] = line.split('\t', 2);
    const normalizedId = id.trim();
    if (normalizedId.length === 0) {
      continue;
    }
    seeds.push({ id: normalizedId, label: (label ?? normalizedId).trim() });
  }
  return seeds;
}

export function parseKimiProviderListJson(stdout: string): ExternalCliModelSeed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const models = (parsed as { models?: unknown }).models;
  if (typeof models !== 'object' || models === null) {
    return [];
  }
  return Object.keys(models).map((id) => ({ id, label: id }));
}

async function resolveRuntimeSeeds(
  providerId: ExternalCliTeamProviderId,
  binaryPath: string
): Promise<ExternalCliModelSeed[] | null> {
  if (providerId === 'antigravity') {
    try {
      const { stdout } = await execCli(binaryPath, ['models'], {
        timeout: RUNTIME_CATALOG_TIMEOUT_MS,
      });
      const seeds = parseAntigravityModelsOutput(stdout);
      return seeds.length > 0 ? seeds : null;
    } catch {
      return null;
    }
  }
  if (providerId === 'kimi') {
    try {
      const { stdout } = await execCli(binaryPath, ['provider', 'list', '--json'], {
        timeout: RUNTIME_CATALOG_TIMEOUT_MS,
      });
      const seeds = parseKimiProviderListJson(stdout);
      return seeds.length > 0 ? seeds : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function resolveExternalCliModelCatalog(
  providerId: ExternalCliTeamProviderId,
  binaryPath: string | null
): Promise<CliProviderModelCatalog> {
  const spec = getExternalCliProviderSpec(providerId);
  if (spec.modelCatalogSource === 'runtime' && binaryPath) {
    const runtimeSeeds = await resolveRuntimeSeeds(providerId, binaryPath);
    if (runtimeSeeds) {
      return buildExternalCliModelCatalog(providerId, 'app-server', runtimeSeeds);
    }
  }
  return buildExternalCliStaticModelCatalog(providerId);
}
