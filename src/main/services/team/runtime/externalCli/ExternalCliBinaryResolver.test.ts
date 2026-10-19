import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveExternalCliBinary } from './ExternalCliBinaryResolver';

function makeFakeLocalAppData(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
  const binDir = path.join(root, 'agy', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'agy.exe'), 'fake-binary');
  return root;
}

describe.skipIf(process.platform !== 'win32')(
  'resolveExternalCliBinary antigravity known install locations',
  () => {
    const originalLocalAppData = process.env.LOCALAPPDATA;

    afterEach(() => {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    });

    it('accepts agy.exe in %LOCALAPPDATA%\\agy\\bin (not only agy.cmd)', async () => {
      const fakeLocalAppData = makeFakeLocalAppData();
      process.env.LOCALAPPDATA = fakeLocalAppData;

      const result = await resolveExternalCliBinary('antigravity', { skipVersionProbe: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.binaryPath).toBe(path.join(fakeLocalAppData, 'agy', 'bin', 'agy.exe'));
      }
    });
  }
);
