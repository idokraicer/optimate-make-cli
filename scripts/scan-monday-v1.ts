/**
 * Scan all Make.com organizations for monday.com connections & affected scenarios.
 * Strategy: orgs -> teams -> connections (filter monday) -> scenarioUsages
 * Then fetch blueprints only for affected scenarios to find specific v1 modules.
 */

const TOKEN = process.env.MAKE_API_TOKEN!;
if (!TOKEN) {
  console.error("Missing MAKE_API_TOKEN in .env");
  process.exit(1);
}

function headers() {
  return { Authorization: `Token ${TOKEN}`, "Content-Type": "application/json" };
}

const DELAY_MS = 350; // delay between API calls to avoid rate limits

async function apiFetch(url: string | URL): Promise<any> {
  await Bun.sleep(DELAY_MS);
  const res = await fetch(url.toString(), { headers: headers() });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get("Retry-After") || "10", 10);
    console.log(`  Rate limited, waiting ${wait}s...`);
    await Bun.sleep(wait * 1000);
    return apiFetch(url);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchAllPages<T>(url: string, key: string): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const u = new URL(url);
    u.searchParams.set("pg[offset]", String(offset));
    u.searchParams.set("pg[limit]", String(limit));
    const data = await apiFetch(u);
    const items: T[] = data[key] ?? [];
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

interface Org { id: number; name: string; zone: string; }
interface Team { id: number; name: string; }
interface Connection {
  id: number;
  name: string;
  accountName: string;
  accountLabel: string;
  accountType: string;
  metadata: { type: string; value: string } | null;
  teamId: number;
  scenarioUsages: { id: number; name: string }[];
}

interface AffectedScenario {
  scenarioId: number;
  scenarioName: string;
  orgId: number;
  orgName: string;
  zone: string;
  teamId: number;
  teamName: string;
  connectionIds: number[];
  connectionNames: string[];
  mondayModules: string[];
  editUrl: string;
}

function findMondayV1Modules(blueprint: any): string[] {
  const results: string[] = [];
  function walk(obj: any) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return; }
    if (typeof obj.module === "string" && obj.module.startsWith("monday:")) {
      const version = obj.version ?? 1;
      if (version === 1 && !obj.module.includes("V2")) {
        results.push(obj.module);
      }
    }
    for (const val of Object.values(obj)) walk(val);
  }
  walk(blueprint);
  return results;
}

async function main() {
  console.log("Scanning all organizations for monday.com connections...\n");

  // 1. Fetch all organizations
  const orgs = await fetchAllPages<Org>("https://eu1.make.com/api/v2/organizations", "organizations");
  console.log(`Found ${orgs.length} organizations\n`);

  // Track affected scenarios (dedup by scenarioId+zone)
  const scenarioMap = new Map<string, AffectedScenario>();
  let orgsWithMonday = 0;
  let totalMondayConnections = 0;

  for (const org of orgs) {
    const base = `https://${org.zone}/api/v2`;

    // 2. Fetch teams
    let teams: Team[];
    try {
      teams = await fetchAllPages<Team>(`${base}/teams?organizationId=${org.id}`, "teams");
    } catch {
      continue;
    }

    let orgHasMonday = false;

    for (const team of teams) {
      // 3. Fetch connections
      let conns: Connection[];
      try {
        conns = await fetchAllPages<Connection>(`${base}/connections?teamId=${team.id}`, "connections");
      } catch {
        continue;
      }

      // 4. Filter to monday.com connections
      const mondayConns = conns.filter(c =>
        c.accountType?.toLowerCase().includes("monday") ||
        c.accountName?.toLowerCase().includes("monday") ||
        c.name?.toLowerCase().includes("monday")
      );

      if (mondayConns.length === 0) continue;

      orgHasMonday = true;
      totalMondayConnections += mondayConns.length;

      console.log(`  ${org.name} / ${team.name}: ${mondayConns.length} monday connection(s)`);

      for (const conn of mondayConns) {
        const usages = conn.scenarioUsages ?? [];
        console.log(`    Connection "${conn.name}" (${conn.id}) — ${usages.length} scenario(s)`);

        for (const usage of usages) {
          const key = `${org.zone}-${usage.id}`;
          if (!scenarioMap.has(key)) {
            scenarioMap.set(key, {
              scenarioId: usage.id,
              scenarioName: usage.name,
              orgId: org.id,
              orgName: org.name,
              zone: org.zone,
              teamId: team.id,
              teamName: team.name,
              connectionIds: [],
              connectionNames: [],
              mondayModules: [],
              editUrl: `https://${org.zone}/scenarios/${usage.id}/edit`,
            });
          }
          const entry = scenarioMap.get(key)!;
          if (!entry.connectionIds.includes(conn.id)) {
            entry.connectionIds.push(conn.id);
            entry.connectionNames.push(conn.name);
          }
        }
      }
    }

    if (orgHasMonday) orgsWithMonday++;
  }

  const affected = [...scenarioMap.values()];
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Found ${totalMondayConnections} monday.com connection(s) across ${orgsWithMonday} org(s)`);
  console.log(`${affected.length} unique scenario(s) use monday.com connections`);
  console.log(`${"─".repeat(60)}\n`);

  if (affected.length === 0) {
    console.log("No scenarios with monday.com connections found.");
    return;
  }

  // 5. Fetch blueprints for affected scenarios to find v1 modules
  console.log("Fetching blueprints to identify v1 modules...\n");

  const withV1: AffectedScenario[] = [];

  for (const s of affected) {
    process.stdout.write(`  Checking "${s.scenarioName}" (${s.scenarioId})...`);
    try {
      const data = await apiFetch(`https://${s.zone}/api/v2/scenarios/${s.scenarioId}/blueprint`);
      s.mondayModules = findMondayV1Modules(data.response?.blueprint);

      if (s.mondayModules.length > 0) {
        withV1.push(s);
        console.log(` ${s.mondayModules.length} v1 module(s)`);
      } else {
        console.log(` already v2 or no monday modules in blueprint`);
      }
    } catch (err: any) {
      console.log(` error: ${err.message}`);
    }
  }

  // Final report
  console.log(`\n${"=".repeat(70)}`);
  console.log(`SCAN COMPLETE`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Organizations scanned: ${orgs.length}`);
  console.log(`Organizations with monday.com: ${orgsWithMonday}`);
  console.log(`Monday.com connections found: ${totalMondayConnections}`);
  console.log(`Scenarios using monday.com: ${affected.length}`);
  console.log(`Scenarios with v1 modules needing upgrade: ${withV1.length}`);
  console.log();

  if (withV1.length === 0) {
    console.log("All monday.com scenarios are already on v2. Nothing to upgrade!");
  } else {
    // Group by org
    const byOrg = new Map<number, AffectedScenario[]>();
    for (const s of withV1) {
      if (!byOrg.has(s.orgId)) byOrg.set(s.orgId, []);
      byOrg.get(s.orgId)!.push(s);
    }

    console.log("SCENARIOS NEEDING UPGRADE:\n");
    for (const [orgId, scenarios] of byOrg) {
      const first = scenarios![0];
      console.log(`Organization: ${first.orgName} (ID: ${orgId}, zone: ${first.zone})`);
      console.log(`${"─".repeat(50)}`);

      for (const s of scenarios!) {
        console.log(`  ${s.scenarioName} (ID: ${s.scenarioId})`);
        console.log(`    Team: ${s.teamName}`);
        console.log(`    Connections: ${s.connectionNames.join(", ")}`);
        console.log(`    V1 modules: ${[...new Set(s.mondayModules)].join(", ")}`);
        console.log(`    Edit: ${s.editUrl}`);
        console.log();
      }
    }
  }

  // Save results
  const output = {
    scanDate: new Date().toISOString(),
    summary: {
      totalOrganizations: orgs.length,
      orgsWithMonday: orgsWithMonday,
      mondayConnections: totalMondayConnections,
      scenariosUsingMonday: affected.length,
      scenariosNeedingUpgrade: withV1.length,
    },
    allAffectedScenarios: affected,
    scenariosNeedingUpgrade: withV1,
  };

  await Bun.write("./scripts/monday-v1-scan-results.json", JSON.stringify(output, null, 2));
  console.log("Results saved to scripts/monday-v1-scan-results.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
