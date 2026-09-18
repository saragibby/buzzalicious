import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The publish path must never consult the AI budget.
 *
 * ADR-0011 and the W6 brief are explicit: `assertAiBudgetAvailable` gates *AI spend*. A
 * workspace that has exhausted its AI ceiling has still paid for publishing, and its
 * already-composed, already-scheduled posts must still go out. Wiring the AI gate into
 * the publish path would mean one workspace's generation overspend silently stops its
 * social presence — a failure mode that looks like a platform outage to the customer and
 * would take a long time to trace back to a budget check.
 *
 * This is a source scan rather than a behavioural test because it is a *structural*
 * guarantee. A behavioural test proves the gate is absent from the paths it exercises; a
 * scan proves it is absent from every path, including ones added later by someone who has
 * never read ADR-0011. The companion end-to-end test in `tests/db/publishing.test.ts`
 * publishes for a workspace that is genuinely over its ceiling, which is the behavioural
 * half of the same claim.
 */

const ROOT = path.resolve(__dirname, '../..');

/** Symbols that gate on AI spend. None may appear under the scanned trees. */
const FORBIDDEN = ['assertAiBudgetAvailable', 'BudgetExceededError'];

const SCANNED = ['modules/publish', 'jobs'];

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('publish path does not gate on the AI budget', () => {
  const files = SCANNED.flatMap((relative) => walk(path.join(ROOT, relative)));

  it('scans a non-trivial number of files', () => {
    // The control. Every assertion below is of the form "no file contains X", which is
    // vacuously true if the walk returned nothing — a renamed directory or a bad path
    // would make this whole file pass while checking absolutely nothing.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.includes('publish.service.ts'))).toBe(true);
    expect(files.some((f) => f.includes(path.join('jobs', 'index.ts')))).toBe(true);
  });

  for (const symbol of FORBIDDEN) {
    it(`no file under ${SCANNED.join(' or ')} references ${symbol}`, () => {
      const offenders = files.filter((file) => {
        // The test file itself names the symbols, by necessity.
        if (file === __filename) return false;
        return readFileSync(file, 'utf8').includes(symbol);
      });

      expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    });
  }

  it('the scan would actually catch a violation', () => {
    // Proves the matcher works, without needing to temporarily break a real file. If
    // `includes` were subtly wrong — a typo'd symbol, a stale list — the assertions above
    // would pass for the wrong reason, which is the dominant defect this repo has had.
    const sample = 'await assertAiBudgetAvailable(db, workspaceId);';
    expect(FORBIDDEN.some((symbol) => sample.includes(symbol))).toBe(true);
  });
});
