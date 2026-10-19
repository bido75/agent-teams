import { describe, expect, it } from 'vitest';

import {
  getProviderTerminalCommand,
  getProviderTerminalCommandById,
  getProviderTerminalLogoutCommand,
  isRuntimeDrivenProviderLoginSupported,
} from './providerTerminalCommands';

import type { CliProviderStatus } from '@shared/types';

function status(providerId: CliProviderStatus['providerId']): CliProviderStatus {
  return { providerId } as CliProviderStatus;
}

describe('providerTerminalCommands external CLI guard', () => {
  it('marks external CLI providers as unsupported for runtime-driven login', () => {
    expect(isRuntimeDrivenProviderLoginSupported('antigravity')).toBe(false);
    expect(isRuntimeDrivenProviderLoginSupported('minimax')).toBe(false);
    expect(isRuntimeDrivenProviderLoginSupported('kimi')).toBe(false);
    expect(isRuntimeDrivenProviderLoginSupported('cline')).toBe(false);
    expect(isRuntimeDrivenProviderLoginSupported('anthropic')).toBe(true);
    expect(isRuntimeDrivenProviderLoginSupported('codex')).toBe(true);
    expect(isRuntimeDrivenProviderLoginSupported('opencode')).toBe(true);
    expect(isRuntimeDrivenProviderLoginSupported('gemini')).toBe(true);
  });

  it('returns null commands for external CLI providers so no --provider flag is emitted', () => {
    for (const providerId of ['antigravity', 'minimax', 'kimi', 'cline'] as const) {
      expect(getProviderTerminalCommandById(providerId, 'login')).toBeNull();
      expect(getProviderTerminalCommandById(providerId, 'logout')).toBeNull();
      expect(getProviderTerminalCommand(status(providerId))).toBeNull();
      expect(getProviderTerminalLogoutCommand(status(providerId))).toBeNull();
    }
  });

  it('keeps runtime commands for supported providers', () => {
    expect(getProviderTerminalCommandById('anthropic', 'login')).toEqual({
      args: ['auth', 'login', '--provider', 'anthropic'],
    });
    expect(getProviderTerminalCommand(status('codex'))).toMatchObject({
      args: ['auth', 'login', '--provider', 'codex'],
    });
    expect(getProviderTerminalLogoutCommand(status('gemini'))).toMatchObject({
      args: ['logout'],
    });
  });
});
