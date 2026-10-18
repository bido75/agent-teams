import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import { getCliFlavorUiOptions, getConfiguredCliFlavor } from '../team/cliFlavor';
import { EXTERNAL_CLI_TEAM_PROVIDER_IDS } from '../team/runtime/externalCli';

import { FRONTEND_PROVIDER_IDS } from './cliInstallerStatusAuthority';

import type { CliInstallationStatus, CliProviderId } from '@shared/types';

const PROVIDER_DISPLAY_NAMES: Record<CliProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode (200+ models)',
  antigravity: 'Antigravity',
  minimax: 'MiniMax Code',
  kimi: 'Kimi Code',
  cline: 'Cline',
};

const SEED_PROVIDER_IDS: readonly CliProviderId[] = [
  ...FRONTEND_PROVIDER_IDS,
  ...EXTERNAL_CLI_TEAM_PROVIDER_IDS,
];
const EXTERNAL_CLI_PROVIDER_ID_SET = new Set<string>(EXTERNAL_CLI_TEAM_PROVIDER_IDS);

export function buildInitialCliInstallationStatus(): CliInstallationStatus {
  const flavor = getConfiguredCliFlavor();
  const ui = getCliFlavorUiOptions(flavor);
  return {
    flavor,
    displayName: ui.displayName,
    supportsSelfUpdate: ui.supportsSelfUpdate,
    showVersionDetails: ui.showVersionDetails,
    showBinaryPath: ui.showBinaryPath,
    installed: false,
    installedVersion: null,
    binaryPath: null,
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: true,
    authMethod: null,
    providers:
      flavor === 'agent_teams_orchestrator'
        ? SEED_PROVIDER_IDS.map((providerId) => ({
            providerId,
            displayName: PROVIDER_DISPLAY_NAMES[providerId],
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown' as const,
            modelVerificationState: 'idle' as const,
            statusMessage: 'Checking...',
            models: [],
            modelAvailability: [],
            canLoginFromUi:
              providerId !== 'opencode' && !EXTERNAL_CLI_PROVIDER_ID_SET.has(providerId),
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
            backend: null,
          }))
        : [],
  };
}
