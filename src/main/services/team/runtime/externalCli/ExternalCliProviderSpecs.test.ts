import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildExternalCliStaticModelCatalog,
  parseAntigravityModelsOutput,
  parseKimiProviderListJson,
  resolveExternalCliModelCatalog,
} from './ExternalCliModelCatalogSource';
import {
  EXTERNAL_CLI_PROVIDER_SPECS,
  EXTERNAL_CLI_TEAM_PROVIDER_IDS,
  getExternalCliProviderSpec,
  isExternalCliTeamProviderId,
  listExternalCliProviderSpecs,
} from './ExternalCliProviderSpecs';
import {
  externalCliSupervisorKey,
  getExternalCliSupervisorRecord,
  listExternalCliSupervisorRecords,
  registerExternalCliSupervisor,
  stopExternalCliSupervisorsForRun,
  unregisterExternalCliSupervisor,
} from './ExternalCliSupervisorRegistry';

import type { ExternalCliMemberSupervisor } from './ExternalCliMemberSupervisor';

function fakeSupervisor(): {
  supervisor: ExternalCliMemberSupervisor;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn().mockResolvedValue(undefined);
  return { supervisor: { stop } as unknown as ExternalCliMemberSupervisor, stop };
}

describe('ExternalCliProviderSpecs', () => {
  it('narrows provider ids through the type guard', () => {
    for (const providerId of EXTERNAL_CLI_TEAM_PROVIDER_IDS) {
      expect(isExternalCliTeamProviderId(providerId)).toBe(true);
    }
    expect(isExternalCliTeamProviderId('anthropic')).toBe(false);
    expect(isExternalCliTeamProviderId('opencode')).toBe(false);
    expect(isExternalCliTeamProviderId(undefined)).toBe(false);
    expect(isExternalCliTeamProviderId('agy')).toBe(false);
  });

  it('builds headless args for each provider', () => {
    expect(
      EXTERNAL_CLI_PROVIDER_SPECS.antigravity.buildHeadlessArgs({ prompt: 'do work' })
    ).toEqual(['-p', 'do work', '--output-format', 'stream-json']);
    expect(
      EXTERNAL_CLI_PROVIDER_SPECS.antigravity.buildHeadlessArgs({
        prompt: 'x',
        model: 'gemini-2.5',
      })
    ).toContain('--model');
    expect(EXTERNAL_CLI_PROVIDER_SPECS.minimax.buildHeadlessArgs({ prompt: 'do work' })).toEqual([
      'exec',
      'do work',
      '--output-format',
      'stream-json',
      '--permission',
      'off',
    ]);
    expect(EXTERNAL_CLI_PROVIDER_SPECS.kimi.buildHeadlessArgs({ prompt: 'do work' })).toEqual([
      '--print',
      '-p',
      'do work',
      '--output-format',
      'stream-json',
    ]);
    expect(EXTERNAL_CLI_PROVIDER_SPECS.cline.buildHeadlessArgs({ prompt: 'do work' })).toEqual([
      '--json',
      '--auto-approve',
      'true',
      'do work',
    ]);
  });

  it('exposes unique env override vars and MCP install targets', () => {
    const envVars = new Set<string>();
    for (const spec of listExternalCliProviderSpecs()) {
      expect(envVars.has(spec.envOverrideVar)).toBe(false);
      envVars.add(spec.envOverrideVar);
      expect(spec.installHint.length).toBeGreaterThan(0);
      expect(spec.authHint.length).toBeGreaterThan(0);
    }
    expect(getExternalCliProviderSpec('cline').mcpInstall).toMatchObject({
      kind: 'env-config-path',
      envVar: 'CLINE_MCP_SETTINGS_PATH',
    });
    expect(getExternalCliProviderSpec('minimax').mcpInstall).toMatchObject({
      kind: 'project-file',
      relativePath: '.mcp.json',
    });
    expect(getExternalCliProviderSpec('antigravity').extraSpawnEnv).toBeUndefined();
    expect(getExternalCliProviderSpec('kimi').extraSpawnEnv).toEqual({
      KIMI_CODE_TRUST_WORKSPACE: '1',
    });
  });

  it('declares a model catalog source for every provider', () => {
    const sources = new Map<string, string>();
    for (const spec of listExternalCliProviderSpecs()) {
      expect(spec.modelCatalogSource === 'runtime' || spec.modelCatalogSource === 'static').toBe(
        true
      );
      sources.set(spec.providerId, spec.modelCatalogSource);
    }
    expect(sources.get('antigravity')).toBe('runtime');
    expect(sources.get('kimi')).toBe('runtime');
    expect(sources.get('minimax')).toBe('static');
    expect(sources.get('cline')).toBe('static');
  });
});

describe('ExternalCliModelCatalogSource', () => {
  it('parses agy models TSV output and skips progress lines', () => {
    const seeds = parseAntigravityModelsOutput(
      [
        'Fetching available models...',
        'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
        '',
        'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      ].join('\n')
    );
    expect(seeds).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('parses kimi provider list JSON model keys', () => {
    const seeds = parseKimiProviderListJson(
      JSON.stringify({ providers: {}, models: { 'kimi-k2.5': {}, 'kimi-k2-turbo': {} } })
    );
    expect(seeds).toEqual([
      { id: 'kimi-k2.5', label: 'kimi-k2.5' },
      { id: 'kimi-k2-turbo', label: 'kimi-k2-turbo' },
    ]);
    expect(parseKimiProviderListJson('not-json')).toEqual([]);
    expect(parseKimiProviderListJson('{"providers":{}}')).toEqual([]);
  });

  it('builds a fresh ready static catalog with the first model as default', () => {
    const catalog = buildExternalCliStaticModelCatalog('minimax', 1_700_000_000_000);
    expect(catalog).toMatchObject({
      schemaVersion: 1,
      providerId: 'minimax',
      source: 'static-fallback',
      status: 'ready',
      defaultModelId: 'MiniMax-M2',
      defaultLaunchModel: 'MiniMax-M2',
    });
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]?.isDefault).toBe(true);
    expect(Date.parse(catalog.staleAt)).toBeGreaterThan(Date.parse(catalog.fetchedAt));
  });

  it('falls back to the static catalog when the binary is unavailable or runtime parse fails', async () => {
    const withoutBinary = await resolveExternalCliModelCatalog('antigravity', null);
    expect(withoutBinary.source).toBe('static-fallback');

    const staticOnly = await resolveExternalCliModelCatalog('minimax', null);
    expect(staticOnly.source).toBe('static-fallback');
    expect(staticOnly.providerId).toBe('minimax');
  });
});

describe('ExternalCliSupervisorRegistry', () => {
  it('registers, looks up, lists, and unregisters supervisors by run and member', () => {
    const { supervisor } = fakeSupervisor();
    registerExternalCliSupervisor({
      supervisor,
      teamName: 'team-a',
      memberName: 'alice',
      runId: 'run-1',
      providerId: 'kimi',
    });

    expect(externalCliSupervisorKey('run-1', 'alice')).toBe('run-1:alice');
    expect(getExternalCliSupervisorRecord('run-1', 'alice')?.supervisor).toBe(supervisor);
    expect(getExternalCliSupervisorRecord('run-2', 'alice')).toBeUndefined();
    expect(listExternalCliSupervisorRecords()).toHaveLength(1);

    unregisterExternalCliSupervisor('run-1', 'alice');
    expect(getExternalCliSupervisorRecord('run-1', 'alice')).toBeUndefined();
  });

  it('stops only supervisors belonging to the requested run and replaces on re-register', async () => {
    const first = fakeSupervisor();
    const second = fakeSupervisor();
    const other = fakeSupervisor();
    registerExternalCliSupervisor({
      supervisor: first.supervisor,
      teamName: 'team-a',
      memberName: 'alice',
      runId: 'run-1',
      providerId: 'cline',
    });
    registerExternalCliSupervisor({
      supervisor: other.supervisor,
      teamName: 'team-a',
      memberName: 'bob',
      runId: 'run-2',
      providerId: 'cline',
    });
    registerExternalCliSupervisor({
      supervisor: second.supervisor,
      teamName: 'team-a',
      memberName: 'alice',
      runId: 'run-1',
      providerId: 'cline',
    });
    expect(first.stop).toHaveBeenCalled();

    const stopped = await stopExternalCliSupervisorsForRun('run-1');
    expect(stopped).toEqual(['alice']);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(other.stop).not.toHaveBeenCalled();
    expect(getExternalCliSupervisorRecord('run-2', 'bob')).toBeDefined();

    await stopExternalCliSupervisorsForRun('run-2');
    expect(other.stop).toHaveBeenCalledTimes(1);
    expect(listExternalCliSupervisorRecords()).toHaveLength(0);
  });

  it('runs the uninstall hook with recorded MCP installs during run stop', async () => {
    const { supervisor } = fakeSupervisor();
    const installs = [
      {
        targetPath: path.join(os.tmpdir(), 'agent-teams-registry-test', '.mcp.json'),
        createdFile: true,
        previousEntry: undefined,
      },
    ];
    registerExternalCliSupervisor({
      supervisor,
      teamName: 'team-a',
      memberName: 'carol',
      runId: 'run-3',
      providerId: 'minimax',
      mcpInstalls: installs,
    });

    const uninstallMcp = vi.fn().mockResolvedValue(undefined);
    const stopped = await stopExternalCliSupervisorsForRun('run-3', { uninstallMcp });
    expect(stopped).toEqual(['carol']);
    expect(uninstallMcp).toHaveBeenCalledWith(installs);
  });
});
