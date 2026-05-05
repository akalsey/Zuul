function parseArgs(argv, spec) {
  const longMap = {};
  const shortMap = {};
  const out = { positional: [], opts: {} };

  for (const [name, def] of Object.entries(spec)) {
    longMap[`--${name}`] = name;
    if (def.short) shortMap[`-${def.short}`] = name;
    if (def.repeatable) out.opts[name] = [];
  }

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];

    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }

    let name = null;
    let value;
    let inlineValue = false;

    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      name = longMap[a.slice(0, eq)];
      value = a.slice(eq + 1);
      inlineValue = true;
    } else if (longMap[a]) {
      name = longMap[a];
    } else if (shortMap[a]) {
      name = shortMap[a];
    } else if (a.startsWith('-')) {
      throw flagError(`unknown flag: ${a}`);
    } else {
      out.positional.push(a);
      i++;
      continue;
    }

    if (!name) throw flagError(`unknown flag: ${a}`);

    if (spec[name].boolean) {
      if (inlineValue) throw flagError(`flag ${a} does not take a value`);
      out.opts[name] = true;
      i++;
      continue;
    }

    if (!inlineValue) value = argv[++i];
    if (value === undefined) throw flagError(`flag ${a} requires a value`);

    if (spec[name].repeatable) out.opts[name].push(value);
    else out.opts[name] = value;
    i++;
  }

  return out;
}

function flagError(msg) {
  const err = new Error(msg);
  err.exitCode = 64;
  return err;
}

module.exports = { parseArgs };
