const fs = require('fs');
const path = require('path');
const { run, which, ExecError } = require('./exec');

async function isInstalled() {
  return (await which('pass')) !== null;
}

function entryExists(passwordStore, entry) {
  return fs.existsSync(path.join(passwordStore, `${entry}.gpg`));
}

async function initRecipients({ passwordStore, subdir, recipients }) {
  const args = ['init'];
  if (subdir) args.push('--path', subdir);
  args.push(...recipients);
  await run('pass', args, {
    env: { ...process.env, PASSWORD_STORE_DIR: passwordStore },
  });
}

async function insert({ passwordStore, entry, content }) {
  const normalized = content.endsWith('\n') ? content : content + '\n';
  await run('pass', ['insert', '--multiline', '--force', entry], {
    env: { ...process.env, PASSWORD_STORE_DIR: passwordStore },
    input: normalized,
  });
}

async function show({ passwordStore, entry }) {
  try {
    const { stdout } = await run('pass', ['show', entry], {
      env: { ...process.env, PASSWORD_STORE_DIR: passwordStore },
    });
    return stdout.replace(/\n$/, '');
  } catch (err) {
    if (err instanceof ExecError && /not in the password store/i.test(err.stderr || '')) {
      const e = new Error(`credential not found: ${entry}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    throw err;
  }
}

async function list({ passwordStore, subdir }) {
  const root = subdir ? path.join(passwordStore, subdir) : passwordStore;
  if (!fs.existsSync(root)) return [];
  const out = [];
  walk(root, root, out);
  return out.sort();
}

function walk(root, dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(root, full, out);
    } else if (name.endsWith('.gpg')) {
      out.push(path.relative(root, full).replace(/\.gpg$/, ''));
    }
  }
}

async function remove({ passwordStore, entry }) {
  await run('pass', ['rm', '--force', entry], {
    env: { ...process.env, PASSWORD_STORE_DIR: passwordStore },
  });
}

function parseEntry(text) {
  const lines = text.split('\n');
  const password = lines[0] || '';
  const fields = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { password, fields };
}

function formatEntry({ password, fields }) {
  const lines = [password];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

module.exports = {
  isInstalled,
  entryExists,
  initRecipients,
  insert,
  show,
  list,
  remove,
  parseEntry,
  formatEntry,
};
