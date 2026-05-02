const config = require('../config');
const pass = require('../pass');

async function run() {
  const cfg = config.requireInitialized();
  const entries = await pass.list({ passwordStore: cfg.passwordStore, subdir: cfg.namespace });
  if (entries.length === 0) {
    process.stderr.write(`zuul: no credentials stored under '${cfg.namespace}/'\n`);
    return;
  }
  for (const e of entries) {
    process.stdout.write(`${cfg.namespace}/${e}\n`);
  }
}

module.exports = { run };
