/**
 * Minimal zero-dependency test harness, matching the existing repo convention of
 * standalone `tsx` scripts that print PASS/FAIL and exit non-zero on failure.
 */
export interface TestRecord {
  name: string;
  ok: boolean;
  detail?: string;
}

const records: TestRecord[] = [];

export async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    records.push({ name, ok: true });
    console.log(`✅ [PASS] ${name} (${Date.now() - started}ms)`);
  } catch (err: any) {
    records.push({ name, ok: false, detail: err?.message });
    console.error(`❌ [FAIL] ${name}\n   ${err?.message}`);
  }
}

/** Prints the summary and exits non-zero when anything failed. */
export function summary(suiteName: string): void {
  const failed = records.filter((r) => !r.ok);
  console.log('\n=====================================================================');
  console.log(`  ${suiteName}`);
  console.log(`  passed: ${records.length - failed.length}/${records.length}`);
  if (failed.length > 0) {
    console.log('  FAILURES:');
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`);
  }
  console.log('=====================================================================\n');
  process.exit(failed.length > 0 ? 1 : 0);
}
