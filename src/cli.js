const COMMANDS = {
  get:    { module: './commands/get',    summary: 'Retrieve a credential by name' },
  list:   { module: './commands/list',   summary: 'List available credentials' },
  add:    { module: './commands/add',    summary: 'Add or update a credential (interactive)' },
  remove: { module: './commands/remove', summary: 'Remove a credential' },
  setup:  { module: './commands/setup',  summary: 'First-time setup: generate keys, configure GPG, init pass' },
  unlock: { module: './commands/unlock', summary: 'Unlock the bot key for the current session (boot-time)' },
  doctor: { module: './commands/doctor', summary: 'Diagnose configuration and runtime issues' },
};

const ALIASES = {
  ls: 'list',
  rm: 'remove',
  show: 'get',
};

function printHelp() {
  process.stdout.write([
    'zuul — conversational secrets management for OpenClaw agents',
    '',
    'Usage: zuul <command> [args]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(8)} ${c.summary}`),
    '',
    'Common flows:',
    '  zuul setup                    # one-time setup',
    '  zuul add metabase             # human stores a credential',
    '  zuul get metabase             # agent retrieves it',
    '  zuul list                     # see what is stored',
    '',
    'Environment:',
    '  ZUUL_NAMESPACE        override the bot-readable namespace',
    '  ZUUL_CONFIG_DIR       override config directory (default ~/.config/zuul)',
    '  PASSWORD_STORE_DIR    override pass storage location',
    '',
  ].join('\n'));
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    printHelp();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    const pkg = require('../package.json');
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  let name = argv[0];
  if (ALIASES[name]) name = ALIASES[name];
  const cmd = COMMANDS[name];

  if (!cmd) {
    process.stderr.write(`zuul: unknown command '${argv[0]}'\n\n`);
    printHelp();
    const err = new Error(`unknown command: ${argv[0]}`);
    err.exitCode = 64;
    throw err;
  }

  const handler = require(cmd.module);
  await handler.run(argv.slice(1));
}

module.exports = { main };
