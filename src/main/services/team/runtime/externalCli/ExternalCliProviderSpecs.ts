export type ExternalCliTeamProviderId = 'antigravity' | 'minimax' | 'kimi' | 'cline';

export const EXTERNAL_CLI_TEAM_PROVIDER_IDS = ['antigravity', 'minimax', 'kimi', 'cline'] as const;

export function isExternalCliTeamProviderId(value: unknown): value is ExternalCliTeamProviderId {
  return (EXTERNAL_CLI_TEAM_PROVIDER_IDS as readonly unknown[]).includes(value);
}

export interface ExternalCliMcpInstallTarget {
  kind: 'env-config-path' | 'project-file' | 'user-file';
  envVar?: string;
  relativePath?: string;
  absolutePathSegments?: readonly string[];
}

export interface ExternalCliHeadlessTurnInput {
  prompt: string;
  model?: string | null;
}

export interface ExternalCliProviderSpec {
  providerId: ExternalCliTeamProviderId;
  displayName: string;
  posixBinaryNames: readonly string[];
  windowsBinaryNames: readonly string[];
  envOverrideVar: string;
  versionArgs: readonly string[];
  installHint: string;
  authHint: string;
  mcpInstall: ExternalCliMcpInstallTarget;
  modelCatalogSource: 'runtime' | 'static';
  extraSpawnEnv?: Readonly<Record<string, string>>;
  buildHeadlessArgs(input: ExternalCliHeadlessTurnInput): string[];
}

function posixNames(name: string): readonly string[] {
  return [name];
}

function windowsNames(name: string): readonly string[] {
  return [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name];
}

export const EXTERNAL_CLI_PROVIDER_SPECS: Readonly<
  Record<ExternalCliTeamProviderId, ExternalCliProviderSpec>
> = {
  antigravity: {
    providerId: 'antigravity',
    displayName: 'Antigravity',
    posixBinaryNames: posixNames('agy'),
    windowsBinaryNames: windowsNames('agy'),
    envOverrideVar: 'AGENT_TEAMS_AGY_CLI_PATH',
    versionArgs: ['--version'],
    installHint:
      'Install the Antigravity CLI: POSIX `curl -fsSL https://antigravity.google/cli/install.sh | bash`; Windows `irm https://antigravity.google/cli/install.ps1 | iex`. Then restart the app so PATH changes apply.',
    authHint:
      'Authenticate with your Google account inside Antigravity, or set GEMINI_API_KEY for API-key usage.',
    mcpInstall: {
      kind: 'user-file',
      absolutePathSegments: ['.gemini', 'config', 'mcp_config.json'],
    },
    modelCatalogSource: 'runtime',
    buildHeadlessArgs: ({ prompt, model }) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      ...(model?.trim() ? ['--model', model.trim()] : []),
    ],
  },
  minimax: {
    providerId: 'minimax',
    displayName: 'MiniMax Code',
    posixBinaryNames: posixNames('mcode'),
    windowsBinaryNames: windowsNames('mcode'),
    envOverrideVar: 'AGENT_TEAMS_MCODE_CLI_PATH',
    versionArgs: ['--version'],
    installHint:
      'Install MiniMax Code: POSIX `curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash`; Windows `irm https://filecdn.minimax.chat/public/install.ps1 | iex`; or `npm i -g @minimax-ai/code`. Then restart the app so PATH changes apply.',
    authHint:
      'Run `mcode login --region global` to sign in with your international MiniMax account (minimax.io), or configure a BYOK provider with `mcode provider add`.',
    mcpInstall: {
      kind: 'project-file',
      relativePath: '.mcp.json',
    },
    modelCatalogSource: 'static',
    buildHeadlessArgs: ({ prompt, model }) => [
      'exec',
      prompt,
      '--output-format',
      'stream-json',
      '--permission',
      'off',
      ...(model?.trim() ? ['--model', model.trim()] : []),
    ],
  },
  kimi: {
    providerId: 'kimi',
    displayName: 'Kimi Code',
    posixBinaryNames: posixNames('kimi'),
    windowsBinaryNames: windowsNames('kimi'),
    envOverrideVar: 'AGENT_TEAMS_KIMI_CLI_PATH',
    versionArgs: ['--version'],
    installHint:
      'Install Kimi Code: POSIX `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`; or `npm i -g @moonshot-ai/kimi-code`. Then restart the app so PATH changes apply.',
    authHint:
      'Run `kimi` once interactively to sign in with Moonshot, or configure providers via `kimi provider add` / `kimi provider catalog`.',
    mcpInstall: {
      kind: 'project-file',
      relativePath: '.kimi-code/mcp.json',
    },
    modelCatalogSource: 'runtime',
    extraSpawnEnv: {
      KIMI_CODE_TRUST_WORKSPACE: '1',
    },
    buildHeadlessArgs: ({ prompt }) => ['--print', '-p', prompt, '--output-format', 'stream-json'],
  },
  cline: {
    providerId: 'cline',
    displayName: 'Cline',
    posixBinaryNames: posixNames('cline'),
    windowsBinaryNames: windowsNames('cline'),
    envOverrideVar: 'AGENT_TEAMS_CLINE_CLI_PATH',
    versionArgs: ['version'],
    installHint:
      'Install the Cline CLI: `npm i -g cline`. Then restart the app so PATH changes apply.',
    authHint:
      'Run `cline auth` (or `cline auth <provider>`) to authenticate, or pass an API key via `cline --key <api-key>`.',
    mcpInstall: {
      kind: 'env-config-path',
      envVar: 'CLINE_MCP_SETTINGS_PATH',
    },
    modelCatalogSource: 'static',
    buildHeadlessArgs: ({ prompt }) => ['--json', '--auto-approve', 'true', prompt],
  },
};

export function getExternalCliProviderSpec(
  providerId: ExternalCliTeamProviderId
): ExternalCliProviderSpec {
  return EXTERNAL_CLI_PROVIDER_SPECS[providerId];
}

export function listExternalCliProviderSpecs(): readonly ExternalCliProviderSpec[] {
  return EXTERNAL_CLI_TEAM_PROVIDER_IDS.map(
    (providerId) => EXTERNAL_CLI_PROVIDER_SPECS[providerId]
  );
}
