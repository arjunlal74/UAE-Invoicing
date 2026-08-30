import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TransmissionMonitorQuery } from '@uae/contracts';
import { describe, expect, it } from 'vitest';

/**
 * Two guards over the transmission monitor's filters, both written after the
 * mistake they describe was made.
 */

describe('transmission monitor query', () => {
  it('reads "false" as false', () => {
    // `z.coerce.boolean()` would make this true: coercion asks whether the
    // string is truthy, and "false" is a non-empty string. A filter that
    // cannot be switched off looks like a filter that does not work — and on
    // `stuck` it would silently hide every healthy document in the monitor.
    expect(TransmissionMonitorQuery.parse({ stuck: 'false' }).stuck).toBe(false);
    expect(TransmissionMonitorQuery.parse({ onlyProblems: 'false' }).onlyProblems).toBe(false);

    expect(TransmissionMonitorQuery.parse({ stuck: 'true' }).stuck).toBe(true);
    expect(TransmissionMonitorQuery.parse({ stuck: '1' }).stuck).toBe(true);
  });

  it('defaults to the support desk view', () => {
    const query = TransmissionMonitorQuery.parse({});
    expect(query.onlyProblems).toBe(true);
    expect(query.stuck).toBe(false);
  });

  /**
   * The filter list and the LIMIT/OFFSET share one parameter sequence, and the
   * page query appends its two after the filters. Adding a filter without
   * moving them hands LIMIT a boolean, which Postgres rejects at run time and
   * TypeScript cannot see at all — so it is asserted here instead.
   */
  it('numbers LIMIT and OFFSET after every filter placeholder', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../routes.ts', import.meta.url)),
      'utf8',
    );

    const limit = source.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
    expect(limit, 'the monitor page query should LIMIT/OFFSET by placeholder').not.toBeNull();

    const [, limitArg, offsetArg] = limit!;
    const filterArgs = source.slice(
      source.indexOf('const filterArgs = ['),
      source.indexOf('];', source.indexOf('const filterArgs = [')),
    );
    const filterCount = filterArgs.split('\n').filter((line) => line.trim().endsWith(',')).length;

    expect(Number(limitArg)).toBe(filterCount + 1);
    expect(Number(offsetArg)).toBe(filterCount + 2);
  });
});
