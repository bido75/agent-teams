import type { InstalledExternalCliMcpState } from './ExternalCliMcpConfigInstaller';
import type { ExternalCliMemberSupervisor } from './ExternalCliMemberSupervisor';

export interface ExternalCliSupervisorRecord {
  supervisor: ExternalCliMemberSupervisor;
  teamName: string;
  memberName: string;
  runId: string;
  providerId: string;
  mcpInstalls?: InstalledExternalCliMcpState[];
}

const activeSupervisors = new Map<string, ExternalCliSupervisorRecord>();

export function externalCliSupervisorKey(runId: string, memberName: string): string {
  return `${runId}:${memberName}`;
}

export function registerExternalCliSupervisor(record: ExternalCliSupervisorRecord): void {
  const key = externalCliSupervisorKey(record.runId, record.memberName);
  const existing = activeSupervisors.get(key);
  if (existing && existing.supervisor !== record.supervisor) {
    void existing.supervisor.stop();
  }
  activeSupervisors.set(key, record);
}

export function getExternalCliSupervisorRecord(
  runId: string,
  memberName: string
): ExternalCliSupervisorRecord | undefined {
  return activeSupervisors.get(externalCliSupervisorKey(runId, memberName));
}

export function listExternalCliSupervisorRecords(): ExternalCliSupervisorRecord[] {
  return [...activeSupervisors.values()];
}

export function unregisterExternalCliSupervisor(runId: string, memberName: string): void {
  activeSupervisors.delete(externalCliSupervisorKey(runId, memberName));
}

export async function stopExternalCliSupervisorsForRun(
  runId: string,
  options: {
    uninstallMcp?: (
      installs: NonNullable<ExternalCliSupervisorRecord['mcpInstalls']>
    ) => Promise<void>;
  } = {}
): Promise<string[]> {
  const stopped: string[] = [];
  for (const [key, record] of [...activeSupervisors.entries()]) {
    if (record.runId !== runId) {
      continue;
    }
    await record.supervisor.stop();
    activeSupervisors.delete(key);
    if (record.mcpInstalls?.length && options.uninstallMcp) {
      await options.uninstallMcp(record.mcpInstalls).catch(() => undefined);
    }
    stopped.push(record.memberName);
  }
  return stopped;
}
