import { spawn } from 'node:child_process';

export const signalTree = async (pid: number, force = false): Promise<void> => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};
