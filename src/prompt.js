const readline = require('readline');

const ETX = 0x03;        // Ctrl-C
const EOT = 0x04;        // Ctrl-D
const LF = 0x0a;
const CR = 0x0d;
const BACKSPACE = 0x08;
const DELETE = 0x7f;

function ensureTTY() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    const err = new Error('this command must be run interactively from a terminal');
    err.exitCode = 4;
    throw err;
  }
}

function ask(question, { defaultValue } = {}) {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

async function confirm(question, { defaultYes = false } = {}) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function readPassword(prompt) {
  ensureTTY();
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const buf = [];
    let done = false;

    const finish = (result, error) => {
      if (done) return;
      done = true;
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(result);
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === LF || byte === CR) {
          return finish(Buffer.from(buf).toString('utf8'));
        }
        if (byte === ETX || byte === EOT) {
          return finish(null, Object.assign(new Error('cancelled'), { exitCode: 130 }));
        }
        if (byte === BACKSPACE || byte === DELETE) {
          buf.pop();
          continue;
        }
        buf.push(byte);
      }
    };

    stdin.on('data', onData);
  });
}

async function readPasswordConfirmed(prompt) {
  while (true) {
    const a = await readPassword(prompt);
    const b = await readPassword('Confirm: ');
    if (a === b) return a;
    process.stderr.write("Passwords don't match. Try again.\n");
  }
}

async function readMultilineFields() {
  process.stderr.write(
    "Enter additional fields one per line as 'key: value'. Empty line to finish.\n"
  );
  const lines = [];
  while (true) {
    const line = await ask('  field');
    if (!line) break;
    if (!/^[^:\s][^:]*:\s*\S/.test(line)) {
      process.stderr.write("  (skipped — expected 'key: value')\n");
      continue;
    }
    lines.push(line);
  }
  return lines;
}

module.exports = {
  ask,
  confirm,
  readPassword,
  readPasswordConfirmed,
  readMultilineFields,
  ensureTTY,
};
