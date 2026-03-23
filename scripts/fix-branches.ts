/**
 * Fixes the Router-based pagination to use the correct 3-route pattern:
 *
 * #3 → Router_Reg:
 *   Route 1 [filter: 3.next_page_token exists]: #87 page2 → #88 SetVar (extra_reg = p2 only)
 *   Route 2 [filter: 87.next_page_token exists]: #89 page3 → #90 SetVar (extra_reg = merge(p2,p3))
 *   Route 3 [no filter, continue]: #4 → Router_Part:
 *     Route 1 [filter: 4.next_page_token exists]: #93 page2 → #94 SetVar (extra_part = p2 only)
 *     Route 2 [filter: 93.next_page_token exists]: #95 page3 → #96 SetVar (extra_part = merge(p2,p3))
 *     Route 3 [no filter, continue]: #97 GetVar → #46 (code uses ifempty) → #6 → #59
 *
 * Key insight: store ONLY the extra pages in variables (not page 1).
 * Page 1 is always accessible directly via {{3.body.registrants}}.
 * Use ifempty(97.extra_reg; emptyarray) in the code module — handles case
 * where extra pages were never fetched (variable was never set).
 */

const bp = await Bun.file("blueprints/4554094.json").json();

function findById(flow: any[], id: number): any {
  for (const m of flow) {
    if (m.id === id) return m;
    if (m.routes) {
      for (const r of m.routes) {
        const found = findById(r.flow || [], id);
        if (found) return found;
      }
    }
  }
  return null;
}

// ── 1. Remove #85 (init SetVar — no longer needed) ──────────────────────────
const mainFlow = bp.flow[3].routes[1].flow; // the route containing #42, #3, ...
const idx85 = mainFlow.findIndex((m: any) => m.id === 85);
if (idx85 === -1) { console.error("Could not find #85"); process.exit(1); }
mainFlow.splice(idx85, 1);
console.log("Removed #85 (init SetVar)");

// ── 2. Fix #88 SetVar: store ONLY p2 (not merge p1+p2) ──────────────────────
const mod88 = findById(bp.flow, 88);
mod88.mapper.variables[0].name  = "extra_registrants";
mod88.mapper.variables[0].value = "{{87.body.registrants}}";
mod88.metadata.designer.name    = "Store Reg Page 2";
mod88.metadata.interface        = [{ name: "extra_registrants", type: "any", label: "extra_registrants" }];
console.log("Fixed #88 SetVar");

// ── 3. Fix #90 SetVar: merge(p2, p3) only ────────────────────────────────────
const mod90 = findById(bp.flow, 90);
mod90.mapper.variables[0].name  = "extra_registrants";
mod90.mapper.variables[0].value = "{{merge(87.body.registrants; 89.body.registrants)}}";
mod90.metadata.designer.name    = "Store Reg Pages 2+3";
mod90.metadata.interface        = [{ name: "extra_registrants", type: "any", label: "extra_registrants" }];
console.log("Fixed #90 SetVar");

// ── 4. Restructure Router #86 into 3 routes ─────────────────────────────────
const router86 = findById(bp.flow, 86);
// Currently: Route 1 = [#87, #88, #89, #90], Route 2 = [#4, #91, #92]
// Target:    Route 1 = [#87, #88], Route 2 = [#89, #90], Route 3 = [#4, #92]

const route86_1_flow = router86.routes[0].flow; // [#87, #88, #89, #90]
const route86_2_flow = router86.routes[1].flow; // [#4, #91, #92]

// Extract modules
const mod87 = route86_1_flow.find((m: any) => m.id === 87);
const mod88_ = route86_1_flow.find((m: any) => m.id === 88);
const mod89 = route86_1_flow.find((m: any) => m.id === 89);
const mod90_ = route86_1_flow.find((m: any) => m.id === 90);
const mod4   = route86_2_flow.find((m: any) => m.id === 4);
// mod91 (#91 init participants SetVar) — drop it
const mod92  = route86_2_flow.find((m: any) => m.id === 92);

router86.routes = [
  { flow: [mod87, mod88_] },           // Route 1: page 2 only
  { flow: [mod89, mod90_] },           // Route 2: page 3 only
  { flow: [mod4,  mod92 ] }            // Route 3: continue (participants)
];
console.log("Restructured Router #86 into 3 routes");

// ── 5. Fix #94 SetVar: store ONLY p2 for participants ───────────────────────
const mod94 = findById(bp.flow, 94);
mod94.mapper.variables[0].name  = "extra_participants";
mod94.mapper.variables[0].value = "{{93.body.participants}}";
mod94.metadata.designer.name    = "Store Part Page 2";
mod94.metadata.interface        = [{ name: "extra_participants", type: "any", label: "extra_participants" }];
console.log("Fixed #94 SetVar");

// ── 6. Fix #96 SetVar: merge(p2, p3) only for participants ──────────────────
const mod96 = findById(bp.flow, 96);
mod96.mapper.variables[0].name  = "extra_participants";
mod96.mapper.variables[0].value = "{{merge(93.body.participants; 95.body.participants)}}";
mod96.metadata.designer.name    = "Store Part Pages 2+3";
mod96.metadata.interface        = [{ name: "extra_participants", type: "any", label: "extra_participants" }];
console.log("Fixed #96 SetVar");

// ── 7. Restructure Router #92 into 3 routes ─────────────────────────────────
const router92 = findById(bp.flow, 92);
// Currently: Route 1 = [#93, #94, #95, #96], Route 2 = [#97, #46, #6, #59]
// Target:    Route 1 = [#93, #94], Route 2 = [#95, #96], Route 3 = [#97, #46, #6, #59]

const route92_1_flow = router92.routes[0].flow; // [#93, #94, #95, #96]
const route92_2_flow = router92.routes[1].flow; // [#97, #46, #6, #59]

const mod93 = route92_1_flow.find((m: any) => m.id === 93);
const mod94_ = route92_1_flow.find((m: any) => m.id === 94);
const mod95 = route92_1_flow.find((m: any) => m.id === 95);
const mod96_ = route92_1_flow.find((m: any) => m.id === 96);

router92.routes = [
  { flow: [mod93, mod94_] },           // Route 1: page 2 only
  { flow: [mod95, mod96_] },           // Route 2: page 3 only
  { flow: route92_2_flow }             // Route 3: continue (#97, #46, #6, #59)
];
console.log("Restructured Router #92 into 3 routes");

// ── 8. Fix #97 GetVar: read extra_registrants + extra_participants ───────────
const mod97 = findById(bp.flow, 97);
mod97.mapper.variables = ["extra_registrants", "extra_participants"];
mod97.metadata.interface = [
  { name: "extra_registrants", type: "any", label: "extra_registrants" },
  { name: "extra_participants", type: "any", label: "extra_participants" }
];
mod97.metadata.restore = { expect: { variables: { items: [null, null] } } };
console.log("Fixed #97 GetVar");

// ── 9. Fix #46 Code module inputs ────────────────────────────────────────────
const mod46 = findById(bp.flow, 46);
for (const inp of mod46.mapper.input) {
  if (inp.name === "registrants") {
    inp.value = "{{merge(3.body.registrants; ifempty(97.extra_registrants; emptyarray))}}";
  }
  if (inp.name === "participants") {
    inp.value = "{{merge(4.body.participants; ifempty(97.extra_participants; emptyarray))}}";
  }
}
console.log("Fixed #46 code module inputs");

// ── Print final structure ────────────────────────────────────────────────────
console.log("\nFinal structure:");
console.log("Router #86 routes:");
for (let i = 0; i < router86.routes.length; i++) {
  console.log(`  Route ${i+1}:`, router86.routes[i].flow.map((m: any) => `#${m.id}`).join(" → "));
}
console.log("Router #92 routes:");
for (let i = 0; i < router92.routes.length; i++) {
  console.log(`  Route ${i+1}:`, router92.routes[i].flow.map((m: any) => `#${m.id}`).join(" → "));
}
console.log("\n#46 inputs:");
for (const inp of mod46.mapper.input) {
  console.log(`  ${inp.name}: ${inp.value}`);
}

await Bun.write("blueprints/4554094.json", JSON.stringify(bp, null, 2));
console.log("\nBlueprint saved.");

export {};
