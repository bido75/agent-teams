import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type ExternalCliTeamProviderId,
  getExternalCliProviderSpec,
} from './ExternalCliProviderSpecs';

import type { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';

const MCP_SERVER_KEY = 'agent-teams';

export type McpServerEntry = Record<string, unknown>;

export interface McpServersDocument {
  mcpServers?: Record<string, McpServerEntry>;
}

export type ExternalCliMcpConfigBuilder = Pick<TeamMcpConfigBuilder, 'writeConfigFile'> &
  Partial<Pick<TeamMcpConfigBuilder, 'removeConfigFile'>>;

export interface InstalledExternalCliMcpState {
  targetPath: string;
  createdFile: boolean;
  previousEntry: McpServerEntry | undefined;
  envVar?: string;
  sourceConfigPath?: string;
}

export interface ExternalCliMcpInstallResult {
  env: Record<string, string>;
  installs: InstalledExternalCliMcpState[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installExternalCliMcpConfig(
  providerId: ExternalCliTeamProviderId,
  cwd: string,
  sourceConfigPath: string,
  options: { mcpConfigBuilder?: ExternalCliMcpConfigBuilder } = {}
): Promise<ExternalCliMcpInstallResult> {
  const spec = getExternalCliProviderSpec(providerId);
  const sourceDoc = await readJsonFile(sourceConfigPath);
  const serverEntry =
    isRecord(sourceDoc) && isRecord(sourceDoc.mcpServers)
      ? (sourceDoc.mcpServers as Record<string, McpServerEntry>)[MCP_SERVER_KEY]
      : undefined;
  if (!serverEntry) {
    options.mcpConfigBuilder?.removeConfigFile?.(sourceConfigPath).catch(() => undefined);
    throw new Error('Generated agent-teams MCP config did not contain the agent-teams server');
  }

  const installs: InstalledExternalCliMcpState[] = [];
  const env: Record<string, string> = {};
  const target = spec.mcpInstall;

  if (target.kind === 'env-config-path' && target.envVar) {
    env[target.envVar] = sourceConfigPath;
    installs.push({
      targetPath: sourceConfigPath,
      createdFile: false,
      previousEntry: undefined,
      envVar: target.envVar,
      sourceConfigPath,
    });
    return { env, installs };
  }

  const targetPath =
    target.kind === 'project-file'
      ? path.join(cwd, target.relativePath ?? '.mcp.json')
      : path.join(
          os.homedir(),
          ...(target.absolutePathSegments ?? ['.gemini', 'config', 'mcp_config.json'])
        );

  const existing = await readJsonFile(targetPath);
  const createdFile = existing === null && !(await pathExists(targetPath));
  const existingDoc: McpServersDocument = isRecord(existing)
    ? (existing as McpServersDocument)
    : {};
  const existingServers = isRecord(existingDoc.mcpServers) ? { ...existingDoc.mcpServers } : {};
  const previousEntry = existingServers[MCP_SERVER_KEY];
  existingServers[MCP_SERVER_KEY] = serverEntry;
  await writeJsonFile(targetPath, { mcpServers: existingServers });
  installs.push({
    targetPath,
    createdFile,
    previousEntry,
    sourceConfigPath,
  });
  return { env, installs };
}

export async function uninstallExternalCliMcpConfigs(
  installs: readonly InstalledExternalCliMcpState[],
  options: { mcpConfigBuilder?: ExternalCliMcpConfigBuilder } = {}
): Promise<void> {
  for (const install of installs) {
    try {
      if (install.envVar) {
        if (install.sourceConfigPath) {
          await options.mcpConfigBuilder
            ?.removeConfigFile?.(install.sourceConfigPath)
            ?.catch(() => undefined);
        }
        continue;
      }
      const existing = await readJsonFile(install.targetPath);
      if (!isRecord(existing) || !isRecord(existing.mcpServers)) {
        if (install.createdFile) {
          await fs.promises.rm(install.targetPath, { force: true });
        }
        continue;
      }
      const servers = { ...(existing.mcpServers as Record<string, McpServerEntry>) };
      if (install.previousEntry === undefined) {
        delete servers[MCP_SERVER_KEY];
      } else {
        servers[MCP_SERVER_KEY] = install.previousEntry;
      }
      if (Object.keys(servers).length === 0 && install.createdFile) {
        await fs.promises.rm(install.targetPath, { force: true });
      } else {
        await writeJsonFile(install.targetPath, { mcpServers: servers });
      }
      if (install.sourceConfigPath) {
        await options.mcpConfigBuilder
          ?.removeConfigFile?.(install.sourceConfigPath)
          .catch(() => undefined);
      }
    } catch {
      // best-effort cleanup
    }
  }
}
