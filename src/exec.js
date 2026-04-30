const { spawn } = require('child_process');

class ExecError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function run(cmd, args = [], options = {}) {
  const { input, env, cwd, capture = true } = options;
  return new Promise((resolve, reject) => {
    const stdio = capture
      ? ['pipe', 'pipe', 'pipe']
      : [input != null ? 'pipe' : 'inherit', 'inherit', 'inherit'];

    const child = spawn(cmd, args, { env: env || process.env, cwd, stdio });

    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    }

    if (input != null) {
      child.stdin.end(input);
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new ExecError(`${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim()}`, {
          code, stdout, stderr,
        }));
      }
    });
  });
}

async function which(cmd) {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

module.exports = { run, which, ExecError };
