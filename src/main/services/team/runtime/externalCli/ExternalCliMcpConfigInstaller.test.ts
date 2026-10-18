import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildExternalCliProviderStatus } from '../../../runtime/externalCliProviderStatus';

import {
  type InstalledExternalCliMcpState,
  installExternalCliMcpConfig,
  uninstallExternalCliMcpConfigs,
} from './ExternalCliMcpConfigInstaller';
import { buildExternalCliStaticModelCatalog } from './ExternalCliModelCatalogSource';

const MCP_SERVER_KEY = 'agent-teams';

function mockBuilder(): {
  writeConfigFile: ReturnType<typeof vi.fn>;
  removeConfigFile: ReturnType<typeof vi.fn>;
} {
  return {
    writeConfigFile: vi.fn(),
    removeConfigFile: vi.fn().mockResolvedValue(undefined),
  };
}

const agentTeamsServer = {
  command: 'node',
  args: ['mcp-server.js'],
  env: { AGENT_TEAMS_CONTROL_URL: 'http://127.0.0.1:1234' },
};

describe('ExternalCliMcpConfigInstaller', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const sourceConfigPath = (): string => path.join(tempDir, 'source-config.json');

  async function writeSourceConfig(servers: Record<string, unknown>): Promise<void> {
    await fs.promises.writeFile(
      sourceConfigPath(),
      JSON.stringify({ mcpServers: servers }),
      'utf8'
    );
  }

  it('installs a project-file target by merging the agent-teams server', async () => {
    const cwd = path.join(tempDir, 'project');
    await fs.promises.mkdir(cwd, { recursive: true });
    const existingPath = path.join(cwd, '.mcp.json');
    await fs.promises.writeFile(
      existingPath,
      JSON.stringify({ mcpServers: { other: { command: 'other-cmd' } } }),
      'utf8'
    );
    await writeSourceConfig({ [MCP_SERVER_KEY]: agentTeamsServer });
    const builder = mockBuilder();

    const result = await installExternalCliMcpConfig('minimax', cwd, sourceConfigPath(), {
      mcpConfigBuilder: builder,
    });

    expect(result.env).toEqual({});
    expect(result.installs).toHaveLength(1);
    expect(result.installs[0]).toMatchObject({
      targetPath: existingPath,
      createdFile: false,
      previousEntry: undefined,
    });

    const written = JSON.parse(await fs.promises.readFile(existingPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers.other).toEqual({ command: 'other-cmd' });
    expect(written.mcpServers[MCP_SERVER_KEY]).toEqual(agentTeamsServer);
  });

  it('restores the previous agent-teams entry and removes files it created', async () => {
    const cwd = path.join(tempDir, 'project');
    await fs.promises.mkdir(cwd, { recursive: true });
    const targetPath = path.join(cwd, '.mcp.json');
    await writeSourceConfig({ [MCP_SERVER_KEY]: agentTeamsServer });
    const builder = mockBuilder();

    const first = await installExternalCliMcpConfig('minimax', cwd, sourceConfigPath(), {
      mcpConfigBuilder: builder,
    });
    expect(first.installs[0].createdFile).toBe(true);

    const previousEntry = { command: 'previous-cmd' };
    await fs.promises.writeFile(
      targetPath,
      JSON.stringify({
        mcpServers: { [MCP_SERVER_KEY]: previousEntry, keep: { command: 'keep-cmd' } },
      }),
      'utf8'
    );
    await writeSourceConfig({ [MCP_SERVER_KEY]: agentTeamsServer });
    const second = await installExternalCliMcpConfig('minimax', cwd, sourceConfigPath(), {
      mcpConfigBuilder: builder,
    });
    expect(second.installs[0].previousEntry).toEqual(previousEntry);

    await uninstallExternalCliMcpConfigs(second.installs, { mcpConfigBuilder: builder });
    const restored = JSON.parse(await fs.promises.readFile(targetPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(restored.mcpServers[MCP_SERVER_KEY]).toEqual(previousEntry);
    expect(restored.mcpServers.keep).toEqual({ command: 'keep-cmd' });

    await fs.promises.writeFile(
      targetPath,
      JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: agentTeamsServer } }),
      'utf8'
    );
    await uninstallExternalCliMcpConfigs(first.installs, { mcpConfigBuilder: builder });
    await expect(fs.promises.access(targetPath)).rejects.toThrow();
  });

  it('supports nested project-file targets', async () => {
    const cwd = path.join(tempDir, 'project');
    await fs.promises.mkdir(cwd, { recursive: true });
    await writeSourceConfig({ [MCP_SERVER_KEY]: agentTeamsServer });
    const builder = mockBuilder();

    const result = await installExternalCliMcpConfig('kimi', cwd, sourceConfigPath(), {
      mcpConfigBuilder: builder,
    });

    const targetPath = path.join(cwd, '.kimi-code', 'mcp.json');
    expect(result.installs[0].targetPath).toBe(targetPath);
    const written = JSON.parse(await fs.promises.readFile(targetPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers[MCP_SERVER_KEY]).toEqual(agentTeamsServer);
  });

  it('exposes the source config path through the env var for env-config targets', async () => {
    const cwd = path.join(tempDir, 'project');
    await fs.promises.mkdir(cwd, { recursive: true });
    await writeSourceConfig({ [MCP_SERVER_KEY]: agentTeamsServer });
    const builder = mockBuilder();

    const result = await installExternalCliMcpConfig('cline', cwd, sourceConfigPath(), {
      mcpConfigBuilder: builder,
    });

    expect(result.env).toEqual({ CLINE_MCP_SETTINGS_PATH: sourceConfigPath() });
    expect(result.installs[0]).toMatchObject({ envVar: 'CLINE_MCP_SETTINGS_PATH' });

    await uninstallExternalCliMcpConfigs(result.installs, { mcpConfigBuilder: builder });
    await expect(fs.promises.access(sourceConfigPath())).resolves.toBeUndefined();
  });

  it('fails when the generated config is missing the agent-teams server', async () => {
    const cwd = path.join(tempDir, 'project');
    await fs.promises.mkdir(cwd, { recursive: true });
    await writeSourceConfig({ other: { command: 'x' } });
    const builder = mockBuilder();

    await expect(
      installExternalCliMcpConfig('minimax', cwd, sourceConfigPath(), { mcpConfigBuilder: builder })
    ).rejects.toThrow(/did not contain the agent-teams server/);
    expect(builder.removeConfigFile).toHaveBeenCalledWith(sourceConfigPath());
  });

  it('tolerates uninstalling into a missing target file', async () => {
    const builder = mockBuilder();
    const installs: InstalledExternalCliMcpState[] = [
      {
        targetPath: path.join(tempDir, 'gone', '.mcp.json'),
        createdFile: false,
        previousEntry: undefined,
      },
    ];
    await expect(
      uninstallExternalCliMcpConfigs(installs, { mcpConfigBuilder: builder })
    ).resolves.toBeUndefined();
  });
});

describe('buildExternalCliProviderStatus', () => {
  it('reports a detected binary as verified and launch-capable', () => {
    const status = buildExternalCliProviderStatus('minimax', {
      ok: true,
      providerId: 'minimax',
      binaryPath: 'C:\\bin\\mcode.cmd',
      versionOutput: '1.2.3',
    });
    expect(status).toMatchObject({
      providerId: 'minimax',
      displayName: 'MiniMax Code',
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      canLoginFromUi: false,
    });
    expect(status.capabilities.teamLaunch).toBe(true);
    expect(status.statusMessage).toContain('C:\\bin\\mcode.cmd');
  });

  it('publishes an attached model catalog and launch model list', () => {
    const catalog = buildExternalCliStaticModelCatalog('minimax', 1_700_000_000_000);
    const status = buildExternalCliProviderStatus(
      'minimax',
      {
        ok: true,
        providerId: 'minimax',
        binaryPath: 'C:\\bin\\mcode.cmd',
        versionOutput: '1.2.3',
      },
      catalog
    );
    expect(status.modelCatalog).toEqual(catalog);
    expect(status.modelCatalogRefreshState).toBe('ready');
    expect(status.models).toEqual(['MiniMax-M2', 'MiniMax-M2.1']);
  });

  it('reports a missing binary with install and auth hints', () => {
    const status = buildExternalCliProviderStatus('kimi', {
      ok: false,
      providerId: 'kimi',
      reason: 'Kimi Code CLI was not found on PATH or in known install locations.',
      installHint: 'npm i -g @moonshot-ai/kimi-code',
      authHint: 'kimi auth login',
      checked: [],
    });
    expect(status).toMatchObject({
      providerId: 'kimi',
      supported: false,
      authenticated: false,
      verificationState: 'unknown',
    });
    expect(status.capabilities.teamLaunch).toBe(false);
    expect(status.detailMessage).toContain('npm i -g @moonshot-ai/kimi-code');
    expect(status.detailMessage).toContain('kimi auth login');
  });
});
