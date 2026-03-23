const data = JSON.parse(await Bun.file("scripts/monday-v1-scan-results.json").text());
const withV1: any[] = data.scenariosNeedingUpgrade;

// 1. Per-org breakdown
const byOrg = new Map<number, { name: string; zone: string; count: number; modules: Set<string> }>();
for (const s of withV1) {
  if (!byOrg.has(s.orgId)) {
    byOrg.set(s.orgId, { name: s.orgName, zone: s.zone, count: 0, modules: new Set() });
  }
  const entry = byOrg.get(s.orgId)!;
  entry.count++;
  for (const m of s.mondayModules) entry.modules.add(m);
}
const orgList = [...byOrg.entries()].sort((a, b) => b[1].count - a[1].count);

console.log("=== PER-ORGANIZATION BREAKDOWN (sorted by scenario count) ===\n");
console.log(`${"Organization".padEnd(45)} ${"Zone".padEnd(16)} ${"Scenarios".padEnd(12)} Module Types`);
console.log("─".repeat(90));
for (const [id, o] of orgList) {
  console.log(`${o.name.padEnd(45)} ${o.zone.padEnd(16)} ${String(o.count).padEnd(12)} ${o.modules.size}`);
}

// 2. Module frequency
console.log("\n=== MONDAY.COM V1 MODULE FREQUENCY ===\n");
const moduleCounts = new Map<string, number>();
for (const s of withV1) {
  for (const m of s.mondayModules) {
    moduleCounts.set(m, (moduleCounts.get(m) || 0) + 1);
  }
}
const sorted = [...moduleCounts.entries()].sort((a, b) => b[1] - a[1]);

console.log(`${"Module".padEnd(55)} Occurrences`);
console.log("─".repeat(70));
for (const [mod, count] of sorted) {
  const bar = "█".repeat(Math.ceil(count / 10));
  console.log(`${mod.padEnd(55)} ${String(count).padStart(5)}  ${bar}`);
}

// 3. Totals
const totalInstances = sorted.reduce((a, b) => a + b[1], 0);
console.log(`\n=== TOTALS ===`);
console.log(`Organizations affected:                ${orgList.length}`);
console.log(`Scenarios needing upgrade:             ${withV1.length}`);
console.log(`Total v1 module instances:             ${totalInstances}`);
console.log(`Unique v1 module types:                ${sorted.length}`);
console.log(`Avg v1 modules per scenario:           ${(totalInstances / withV1.length).toFixed(1)}`);

// 4. Scenarios already on v2 (using monday but no v1 modules)
const allMonday: any[] = data.allAffectedScenarios;
const alreadyV2 = allMonday.length - withV1.length;
console.log(`\nScenarios already on v2 (no action):   ${alreadyV2}`);
console.log(`Scenarios still on v1 (need upgrade):  ${withV1.length}`);
console.log(`Upgrade progress:                      ${((alreadyV2 / allMonday.length) * 100).toFixed(1)}% done`);
