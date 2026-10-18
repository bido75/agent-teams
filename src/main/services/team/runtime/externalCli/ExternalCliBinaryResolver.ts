import { execCli } from '@main/utils/childProcess';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type ExternalCliProviderSpec,
  type ExternalCliTeamProviderId,
  getExternalCliProviderSpec,
} from './ExternalCliProviderSpecs';

const VERSION_PROBE_TIMEOUT_MS = 15_000;

export interface ExternalCliBinaryResolutionSuccess {
  ok: true;
  providerId: ExternalCliTeamProviderId;
  binaryPath: string;
  versionOutput: string;
}

export interface ExternalCliBinaryResolutionFailure {
  ok: false;
  providerId: ExternalCliTeamProviderId;
  reason: string;
  installHint: string;
  authHint: string;
  checked: string[];
}

export type ExternalCliBinaryResolution =
  | ExternalCliBinaryResolutionSuccess
  | ExternalCliBinaryResolutionFailure;

export interface ResolveExternalCliBinaryOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  skipVersionProbe?: boolean;
}

function getKnownInstallDirCandidates(spec: ExternalCliProviderSpec): string[] {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const candidates: string[] = [];
  if (spec.providerId === 'antigravity') {
    candidates.push(path.join(home, '.local', 'bin', 'agy'));
    candidates.push(path.join(localAppData, 'agy', 'bin', 'agy.cmd'));
  }
  if (spec.providerId === 'minimax') {
    candidates.push(path.join(home, '.minimax-code', 'bin', 'mcode'));
    candidates.push(path.join(home, '.local', 'bin', 'mcode'));
    if (process.platform === 'win32') {
      candidates.push(path.join(home, '.minimax-code', 'bin', 'mcode.cmd'));
    }
  }
  if (spec.providerId === 'kimi') {
    candidates.push(path.join(home, '.local', 'bin', 'kimi'));
    if (process.platform === 'win32') {
      candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'kimi.cmd'));
    }
  }
  if (spec.providerId === 'cline') {
    if (process.platform === 'win32') {
      candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'cline.cmd'));
    } else {
      candidates.push(path.join(home, '.local', 'bin', 'cline'));
    }
  }
  return candidates;
}

function getPathDirCandidates(spec: ExternalCliProviderSpec, env: NodeJS.ProcessEnv): string[] {
  const binaryNames =
    process.platform === 'win32' ? spec.windowsBinaryNames : spec.posixBinaryNames;
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of binaryNames) {
      candidates.push(path.join(dir, name));
    }
  }
  return candidates;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function probeVersion(
  spec: ExternalCliProviderSpec,
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string> {
  const { stdout, stderr } = await execCli(binaryPath, [...spec.versionArgs], {
    env,
    timeout: timeoutMs,
  });
  const combined = `${stdout ?? ''}${stderr ?? ''}`.trim();
  if (!combined) {
    throw new Error(`${spec.displayName} version probe produced no output`);
  }
  return combined;
}

export class ExternalCliBinaryResolver {
  resolve(
    providerId: ExternalCliTeamProviderId,
    options: ResolveExternalCliBinaryOptions = {}
  ): Promise<ExternalCliBinaryResolution> {
    return resolveExternalCliBinary(providerId, options);
  }
}

export async function resolveExternalCliBinary(
  providerId: ExternalCliTeamProviderId,
  options: ResolveExternalCliBinaryOptions = {}
): Promise<ExternalCliBinaryResolution> {
  const spec = getExternalCliProviderSpec(providerId);
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const override = env[spec.envOverrideVar]?.trim();
  const orderedCandidates: string[] = [];
  if (override) {
    orderedCandidates.push(override);
  }
  orderedCandidates.push(...getKnownInstallDirCandidates(spec));
  orderedCandidates.push(...getPathDirCandidates(spec, env));
  const bareNames = process.platform === 'win32' ? spec.windowsBinaryNames : spec.posixBinaryNames;
  orderedCandidates.push(...bareNames);

  const seen = new Set<string>();
  const checked: string[] = [];
  let lastProbeError: unknown = null;

  for (const candidate of orderedCandidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const isBareName = !normalized.includes('/') && !normalized.includes('\\');
    if (!isBareName && !(await fileExists(normalized))) {
      checked.push(normalized);
      continue;
    }
    if (isBareName && options.skipVersionProbe) {
      continue;
    }
    checked.push(normalized);
    if (options.skipVersionProbe) {
      return {
        ok: true,
        providerId,
        binaryPath: normalized,
        versionOutput: '',
      };
    }
    try {
      const versionOutput = await probeVersion(spec, normalized, env, timeoutMs);
      return {
        ok: true,
        providerId,
        binaryPath: normalized,
        versionOutput,
      };
    } catch (error) {
      lastProbeError = error;
    }
  }

  const lastErrorText =
    lastProbeError instanceof Error
      ? lastProbeError.message
      : typeof lastProbeError === 'string'
        ? lastProbeError
        : lastProbeError
          ? 'unknown error'
          : null;
  const reason = lastErrorText
    ? `${spec.displayName} CLI was not usable. Last error: ${lastErrorText}`
    : `${spec.displayName} CLI was not found on PATH or in known install locations.`;

  return {
    ok: false,
    providerId,
    reason,
    installHint: spec.installHint,
    authHint: spec.authHint,
    checked,
  };
}
