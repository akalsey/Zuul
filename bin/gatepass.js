#!/usr/bin/env node
require('../src/cli.js').main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`gatepass: ${err.message}\n`);
  process.exit(err.exitCode || 1);
});
