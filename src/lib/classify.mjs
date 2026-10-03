import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { queryJev } from './typesafe.mjs';

/**
 * Shared runner for the roster classifiers (scripts/classify-roster.mjs,
 * scripts/classify-work.mjs). Each subject is `{ id, state }`; `questions` is a
 * TypeSafe question dictionary; `shape(answers, meta)` maps one Jev reply to the
 * row that gets emitted.
 *
 * Exit codes: 0 all subjects classified, 1 any subject failed (a keyless rerun
 * must not look like success), 2 bad arguments.
 */
export async function runClassifier({ name, subjects, questions, shape, argv = process.argv.slice(2) }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', short: 'o' },
      model: { type: 'string', short: 'm' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Usage:
  node scripts/${name}.mjs [--out <file.json>] [--model <jev model>]

Options:
  -o, --out    Write the JSON rows to this file instead of stdout
  -m, --model  Jev model id (default: jev-latest)
  -h, --help   Show this help
`);
    return 0;
  }

  const rows = [];
  let failures = 0;
  for (const subject of subjects) {
    try {
      const r = await queryJev(subject.state, questions, values.model ? { model: values.model } : {});
      rows.push(shape(subject, r));
      console.error(`ok ${subject.id}`);
    } catch (e) {
      failures++;
      rows.push({ id: subject.id, error: e.message });
      console.error(`ERR ${subject.id}: ${e.message}`);
    }
  }

  const json = JSON.stringify(rows, null, 1);
  if (values.out) {
    writeFileSync(values.out, json + '\n');
    console.error(`wrote ${rows.length} rows to ${values.out} (${failures} failed)`);
  } else {
    console.log(json);
  }
  return failures ? 1 : 0;
}
