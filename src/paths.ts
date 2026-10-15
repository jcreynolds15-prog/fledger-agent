import * as path from 'path';

export const AGENT_NAME = 'AP Automation Agent';
export const AGENT_VERSION = '1.2.0';

/** True when running as the packaged Windows executable (a Node single-executable app). */
export function isPackaged(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:sea').isSea() === true;
  } catch {
    return false;
  }
}

/**
 * The folder holding agent.env and the logs: beside the .exe when packaged,
 * so an install is one self-contained folder; the working directory otherwise.
 */
export function homeDir(): string {
  return isPackaged() ? path.dirname(process.execPath) : process.cwd();
}
