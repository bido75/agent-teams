import { killProcessTreeAndWait, spawnCli } from '@main/utils/childProcess';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';

import type { ExternalCliProviderSpec } from './ExternalCliProviderSpecs';

const INBOX_WATCH_INTERVAL_MS = 500;
const WAKE_RESPAWN_DELAY_MS = 750;

export interface ExternalCliMemberSupervisorOptions {
  spec: ExternalCliProviderSpec;
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  inboxPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface ExternalCliTurnExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
}

export class ExternalCliMemberSupervisor {
  private readonly spec: ExternalCliProviderSpec;
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inboxPath: string;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;
  private readonly logger = createLogger('ExternalCliMemberSupervisor');

  private child: ReturnType<typeof spawnCli> | null = null;
  private pendingWake = false;
  private stopped = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private lastExit: ExternalCliTurnExit | null = null;
  private lastTurnPrompt: string | null = null;

  constructor(options: ExternalCliMemberSupervisorOptions) {
    this.spec = options.spec;
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.env = options.env;
    this.inboxPath = options.inboxPath;
    this.stdoutPath = options.stdoutPath;
    this.stderrPath = options.stderrPath;
  }

  startTurn(prompt: string): void {
    if (this.stopped) {
      return;
    }
    if (this.isRunning()) {
      this.lastTurnPrompt = prompt;
      this.pendingWake = true;
      return;
    }
    this.spawnTurn(prompt);
  }

  notifyInboxChanged(): void {
    if (this.stopped) {
      return;
    }
    if (this.isRunning()) {
      this.pendingWake = true;
      return;
    }
    this.scheduleWake();
  }

  isRunning(): boolean {
    const child = this.child;
    return Boolean(child?.pid && child.exitCode == null && child.signalCode == null);
  }

  getLastTurnExit(): ExternalCliTurnExit | null {
    return this.lastExit;
  }

  getInboxPath(): string {
    return this.inboxPath;
  }

  watchInbox(): void {
    if (!fs.existsSync(this.inboxPath)) {
      return;
    }
    fs.watchFile(this.inboxPath, { interval: INBOX_WATCH_INTERVAL_MS }, (current, previous) => {
      if (this.stopped) {
        return;
      }
      if (current.mtimeMs !== previous.mtimeMs) {
        this.notifyInboxChanged();
      }
    });
  }

  adoptRunningChild(child: ReturnType<typeof spawnCli>): void {
    if (this.stopped || this.child === child) {
      return;
    }
    this.child = child;
    child.once('close', (code, signal) => {
      this.lastExit = {
        code,
        signal,
        at: new Date().toISOString(),
      };
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopped) {
        return;
      }
      if (this.pendingWake) {
        this.pendingWake = false;
        this.scheduleWake();
      }
    });
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    fs.unwatchFile(this.inboxPath);
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        await killProcessTreeAndWait(child);
      } catch (error) {
        this.logger.warn(
          `Failed to stop ${this.spec.providerId} teammate process: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private scheduleWake(): void {
    if (this.wakeTimer || this.stopped) {
      return;
    }
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.stopped || this.isRunning()) {
        return;
      }
      this.spawnTurn(this.buildWakePrompt());
    }, WAKE_RESPAWN_DELAY_MS);
  }

  private buildWakePrompt(): string {
    return [
      'Your team inbox received new messages.',
      `Read the inbox file at ${this.inboxPath} to see the latest messages from your teammates.`,
      'Then respond to any messages addressed to you using the agent-teams message_send MCP tool, and continue any assigned work.',
    ].join(' ');
  }

  private spawnTurn(prompt: string): void {
    const args = this.spec.buildHeadlessArgs({ prompt });
    const stdoutLog = fs.createWriteStream(this.stdoutPath, { flags: 'a', mode: 0o600 });
    const stderrLog = fs.createWriteStream(this.stderrPath, { flags: 'a', mode: 0o600 });
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(this.binaryPath, args, {
        cwd: this.cwd,
        detached: true,
        env: {
          ...this.env,
          ...this.spec.extraSpawnEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stdoutLog.destroy();
      stderrLog.destroy();
      this.logger.error(
        `Failed to spawn ${this.spec.providerId} teammate turn: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    this.child = child;
    this.lastTurnPrompt = prompt;
    this.pendingWake = false;
    child.stdout?.pipe(stdoutLog);
    child.stderr?.pipe(stderrLog);
    child.once('close', (code, signal) => {
      this.lastExit = {
        code,
        signal,
        at: new Date().toISOString(),
      };
      stdoutLog.end();
      stderrLog.end();
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopped) {
        return;
      }
      if (this.pendingWake) {
        this.pendingWake = false;
        this.scheduleWake();
      }
    });
    child.once('error', (error) => {
      this.logger.error(`${this.spec.providerId} teammate process error: ${error.message}`);
      stdoutLog.end();
      stderrLog.end();
      if (this.child === child) {
        this.child = null;
      }
    });
    child.unref();
  }
}
