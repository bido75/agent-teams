import { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExternalCliBinaryResolver } from './ExternalCliBinaryResolver';
import {
  installExternalCliMcpConfig,
  uninstallExternalCliMcpConfigs,
} from './ExternalCliMcpConfigInstaller';
import { ExternalCliMemberSupervisor } from './ExternalCliMemberSupervisor';
import {
  type ExternalCliTeamProviderId,
  getExternalCliProviderSpec,
} from './ExternalCliProviderSpecs';
import {
  listExternalCliSupervisorRecords,
  registerExternalCliSupervisor,
  stopExternalCliSupervisorsForRun,
} from './ExternalCliSupervisorRegistry';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimePrepareResult,
  TeamRuntimeReconcileInput,
  TeamRuntimeReconcileResult,
  TeamRuntimeStopInput,
  TeamRuntimeStopResult,
} from '../TeamRuntimeAdapter';

function buildWakePrompt(memberName: string, teamName: string, inboxPath: string): string {
  return [
    `You are ${memberName}, a teammate on team "${teamName}".`,
    'You are running in headless turn mode: each process start handles one turn of team work.',
    `Your team inbox is the JSON file at ${inboxPath}. Read it to see new messages from teammates.`,
    'Use the agent-teams message_send MCP tool to reply, report status, or ask questions.',
    'Complete the work you can, then end the turn.',
  ].join(' ');
}

export class ExternalCliTeamRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId: ExternalCliTeamProviderId;

  private readonly resolver: ExternalCliBinaryResolver;
  private readonly mcpConfigBuilder: TeamMcpConfigBuilder;

  constructor(
    providerId: ExternalCliTeamProviderId,
    options: {
      resolver?: ExternalCliBinaryResolver;
      mcpConfigBuilder?: TeamMcpConfigBuilder;
    } = {}
  ) {
    this.providerId = providerId;
    this.resolver = options.resolver ?? new ExternalCliBinaryResolver();
    this.mcpConfigBuilder = options.mcpConfigBuilder ?? new TeamMcpConfigBuilder();
  }

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    const resolution = await this.resolver.resolve(this.providerId);
    if (!resolution.ok) {
      return {
        ok: false,
        providerId: this.providerId,
        reason: `${resolution.reason} ${resolution.installHint}`,
        diagnostics: [
          `${this.providerId}: checked ${resolution.checked.length} candidate paths`,
          resolution.authHint,
        ],
        warnings: [],
        retryable: true,
      };
    }
    const diagnostics = [`Resolved ${this.providerId} CLI at ${resolution.binaryPath}`];
    if (resolution.versionOutput) {
      diagnostics.push(`Version probe: ${resolution.versionOutput.split('\n')[0]}`);
    }
    return {
      ok: true,
      providerId: this.providerId,
      modelId: input.model ?? null,
      diagnostics,
      warnings: [],
    };
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    const prepareResult = await this.prepare(input);
    if (!prepareResult.ok) {
      return this.buildLaunchResult({
        runId: input.runId,
        teamName: input.teamName,
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: this.buildMemberEvidenceFromSpecs(input.expectedMembers, 'failed_to_start', [
          prepareResult.reason,
        ]),
        warnings: [],
        diagnostics: prepareResult.diagnostics,
      });
    }

    const resolution = await this.resolver.resolve(this.providerId);
    if (!resolution.ok) {
      throw new Error(`Resolved ${this.providerId} CLI disappeared before launch`);
    }

    const diagnostics: string[] = [...prepareResult.diagnostics];
    const warnings: string[] = [];
    const memberEvidence: Record<string, TeamRuntimeMemberLaunchEvidence> = {};

    for (const member of input.expectedMembers) {
      const existing = listExternalCliSupervisorRecords().find(
        (record) =>
          record.runId === input.runId &&
          record.memberName === member.name &&
          record.providerId === this.providerId
      );
      if (existing) {
        await existing.supervisor.stop();
      }

      const inboxPath = this.buildInboxPath(input.teamName, member.name);
      const logDir = this.buildMemberLogDir(input.teamName, member.name);
      await fs.promises.mkdir(logDir, { recursive: true });

      let memberMcpEnv: Record<string, string> = {};
      let mcpInstalls: Awaited<ReturnType<typeof installExternalCliMcpConfig>>['installs'] = [];
      try {
        const sourceConfigPath = await this.mcpConfigBuilder.writeConfigFile(input.cwd, {
          controlApiBaseUrl: null,
        });
        const installResult = await installExternalCliMcpConfig(
          this.providerId,
          input.cwd,
          sourceConfigPath,
          { mcpConfigBuilder: this.mcpConfigBuilder }
        );
        memberMcpEnv = installResult.env;
        mcpInstalls = installResult.installs;
      } catch (error) {
        warnings.push(
          `Failed to install agent-teams MCP config for ${member.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const supervisor = new ExternalCliMemberSupervisor({
        spec: getExternalCliProviderSpec(this.providerId),
        binaryPath: resolution.binaryPath,
        cwd: input.cwd,
        env: {
          ...process.env,
          ...memberMcpEnv,
        },
        inboxPath,
        stdoutPath: path.join(logDir, 'stdout.log'),
        stderrPath: path.join(logDir, 'stderr.log'),
      });

      const prompt =
        input.prompt?.trim() || buildWakePrompt(member.name, input.teamName, inboxPath);
      supervisor.startTurn(prompt);
      supervisor.watchInbox();

      registerExternalCliSupervisor({
        supervisor,
        teamName: input.teamName,
        memberName: member.name,
        runId: input.runId,
        providerId: this.providerId,
        mcpInstalls,
      });

      memberEvidence[member.name] = this.buildEvidence(member, supervisor);
      diagnostics.push(
        `${member.name}: spawned ${this.providerId} headless turn (pid ${
          supervisor.isRunning() ? 'active' : 'idle'
        })`
      );
    }

    return this.buildLaunchResult({
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'active',
      teamLaunchState: 'clean_success',
      members: memberEvidence,
      warnings,
      diagnostics,
    });
  }

  async reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult> {
    const memberEvidence: Record<string, TeamRuntimeMemberLaunchEvidence> = {};
    const diagnostics: string[] = [];
    for (const member of input.expectedMembers) {
      const record = listExternalCliSupervisorRecords().find(
        (r) =>
          r.runId === input.runId &&
          r.memberName === member.name &&
          r.providerId === this.providerId
      );
      if (!record) {
        memberEvidence[member.name] = this.buildEvidence(member, null);
        diagnostics.push(`${member.name}: no external CLI supervisor registered`);
        continue;
      }
      memberEvidence[member.name] = this.buildEvidence(member, record.supervisor);
    }
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'active',
      teamLaunchState: 'partial_pending',
      members: memberEvidence,
      snapshot: input.previousLaunchState,
      warnings: [],
      diagnostics,
    };
  }

  async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    const members: TeamRuntimeStopResult['members'] = {};
    const diagnostics: string[] = [];
    const stopped = await stopExternalCliSupervisorsForRun(input.runId, {
      uninstallMcp: (installs) =>
        uninstallExternalCliMcpConfigs(installs, {
          mcpConfigBuilder: this.mcpConfigBuilder,
        }),
    });
    for (const memberName of stopped) {
      members[memberName] = {
        memberName,
        providerId: this.providerId,
        stopped: true,
        diagnostics: [`Stopped ${this.providerId} teammate supervisor`],
      };
      diagnostics.push(`Stopped supervisor for ${memberName}`);
    }
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members,
      warnings: [],
      diagnostics,
    };
  }

  private buildInboxPath(teamName: string, memberName: string): string {
    return path.join(getClaudeBasePath(), 'teams', teamName, 'inboxes', `${memberName}.json`);
  }

  private buildMemberLogDir(teamName: string, memberName: string): string {
    return path.join(os.tmpdir(), 'agent-teams-external', teamName, memberName, randomUUID());
  }

  private buildEvidence(
    member: TeamRuntimeMemberSpec,
    supervisor: ExternalCliMemberSupervisor | null
  ): TeamRuntimeMemberLaunchEvidence {
    const running = supervisor?.isRunning() ?? false;
    const lastExit = supervisor?.getLastTurnExit() ?? null;
    return {
      memberName: member.name,
      providerId: this.providerId,
      ...(member.model ? { model: member.model } : {}),
      launchState: running || lastExit ? 'confirmed_alive' : 'starting',
      agentToolAccepted: true,
      runtimeAlive: running,
      bootstrapConfirmed: running || lastExit !== null,
      hardFailure: false,
      diagnostics: [
        running
          ? `${this.providerId} headless turn is running`
          : lastExit
            ? `last ${this.providerId} turn exited with code ${lastExit.code ?? 'null'}`
            : `${this.providerId} supervisor is armed but idle`,
      ],
    };
  }

  private buildMemberEvidenceFromSpecs(
    members: readonly TeamRuntimeMemberSpec[],
    launchState: TeamRuntimeMemberLaunchEvidence['launchState'],
    diagnostics: string[]
  ): Record<string, TeamRuntimeMemberLaunchEvidence> {
    const evidence: Record<string, TeamRuntimeMemberLaunchEvidence> = {};
    for (const member of members) {
      evidence[member.name] = {
        memberName: member.name,
        providerId: this.providerId,
        launchState,
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: diagnostics.join(' '),
        diagnostics: [...diagnostics],
      };
    }
    return evidence;
  }

  private buildLaunchResult(input: {
    runId: string;
    teamName: string;
    launchPhase: TeamRuntimeLaunchResult['launchPhase'];
    teamLaunchState: TeamRuntimeLaunchResult['teamLaunchState'];
    members: Record<string, TeamRuntimeMemberLaunchEvidence>;
    warnings: string[];
    diagnostics: string[];
  }): TeamRuntimeLaunchResult {
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: input.launchPhase,
      teamLaunchState: input.teamLaunchState,
      members: input.members,
      warnings: input.warnings,
      diagnostics: input.diagnostics,
    };
  }
}
