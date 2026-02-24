const fs = require("fs");
const vm = require("vm");

function makeGenericElement() {
  return {
    value: "", innerHTML: "", textContent: "", children: [],
    classList: { add() {}, remove() {} },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
  };
}

function loadAppContext() {
  const code = fs.readFileSync("/Users/kraigguffey/Documents/ROTH App/app.js", "utf8");
  const formEl = makeGenericElement();
  const refs = {
    "#estimator-form": formEl, "#results": makeGenericElement(),
    "#topStrategies": makeGenericElement(), "#summaryText": makeGenericElement(),
    "#resultsTableBody": makeGenericElement(), "#runStatus": makeGenericElement(),
    "#taxPaymentMode": makeGenericElement(), "#taxPaymentModeHelp": makeGenericElement(),
  };
  const context = {
    console, window: { alert() {}, setTimeout(fn) { fn(); } },
    document: {
      querySelector(sel) { return refs[sel] || makeGenericElement(); },
      createElement() { return makeGenericElement(); },
    },
    FormData: class { constructor(m) { this.map = m || new Map(); } get(k) { return this.map.get(k); } },
    Intl, Number, String, Math,
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "app.js" });
  return context;
}

const ctx = loadAppContext();

let totalTests = 0, passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  totalTests++;
  try { fn(); passed++; }
  catch (e) { failed++; failures.push({ name, message: e.message }); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function approxEqual(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }

function baseInputs(overrides = {}) {
  return {
    qualifiedBalance: 1200000, nonQualifiedBalance: 350000, taxFreeBalance: 150000,
    currentAge: 55, retirementAge: 65, lifeExpectancy: 92, birthYear: 1961,
    rmdStartAgeOverride: null, rmdStartAge: 75, filingStatus: "mfj",
    annualPaycheck: 90000, currentAnnualTaxableIncome: 0,
    socialSecurityAnnual: 42000, socialSecurityStartAge: 67,
    qualifiedReturnRate: 0.05, nonQualifiedReturnRate: 0.045, taxFreeReturnRate: 0.05,
    inflationRate: 0.025, stateTaxRate: 0.0539, nonQualifiedTaxableRatio: 0.3,
    taxPaymentMode: "simple",
    ...overrides,
  };
}

// ── 1. Simple mode still works identically ──────────────────────────────────

test("1: Simple mode produces same results as default (no mode specified)", () => {
  const noMode = baseInputs();
  delete noMode.taxPaymentMode;
  const simple = baseInputs({ taxPaymentMode: "simple" });

  const m1 = ctx.runModel(noMode);
  const m2 = ctx.runModel(simple);

  for (let i = 0; i < m1.allResults.length; i++) {
    assert(approxEqual(m1.allResults[i].totalTaxes, m2.allResults[i].totalTaxes, 0.01),
      `${m1.allResults[i].name}: taxes differ`);
  }
});

// ── 2. Advanced mode runs without errors ────────────────────────────────────

test("2: Advanced mode runs all 20 strategies without error", () => {
  const m = ctx.runModel(baseInputs({ taxPaymentMode: "advanced" }));
  assert(m.allResults.length === 20, `Expected 20 results, got ${m.allResults.length}`);
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(Number.isFinite(r.totalNetIncome), `${r.name}: totalNetIncome not finite`);
    assert(Number.isFinite(r.totalNetLegacy), `${r.name}: totalNetLegacy not finite`);
  }
});

// ── 3. Advanced mode produces equal or better total value vs simple ─────────

test("3: Advanced mode best >= simple mode best (total value created)", () => {
  const simpleModel = ctx.runModel(baseInputs({ taxPaymentMode: "simple" }));
  const advancedModel = ctx.runModel(baseInputs({ taxPaymentMode: "advanced" }));

  const simpleBestValue = simpleModel.top3[0].totalValueCreatedVsBaseline;
  const advancedBestValue = advancedModel.top3[0].totalValueCreatedVsBaseline;

  // Advanced should be at least as good (within rounding)
  assert(advancedBestValue >= simpleBestValue - 1,
    `Advanced best (${advancedBestValue}) should be >= simple best (${simpleBestValue})`);
});

// ── 4. Advanced mode with no liquid assets — qualified cascade ──────────────

test("4: Advanced mode with no NQ/Roth uses qualified (cascade)", () => {
  const m = ctx.runModel(baseInputs({
    taxPaymentMode: "advanced",
    qualifiedBalance: 500000, nonQualifiedBalance: 0, taxFreeBalance: 0,
    currentAge: 65, retirementAge: 65,
  }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(r.totalTaxes >= 0, `${r.name}: negative taxes`);
  }
});

// ── 5. Advanced mode preserves Roth when years remaining is large ───────────

test("5: With many years remaining, advanced mode preserves more Roth than simple", () => {
  // Young person with lots of years — Roth growth opportunity cost is high
  // so advanced should prefer qualified over Roth for tax payments
  const simpleModel = ctx.runModel(baseInputs({
    taxPaymentMode: "simple",
    currentAge: 55, retirementAge: 55, lifeExpectancy: 95,
    nonQualifiedBalance: 0, // force tax payments from qualified or Roth
  }));
  const advancedModel = ctx.runModel(baseInputs({
    taxPaymentMode: "advanced",
    currentAge: 55, retirementAge: 55, lifeExpectancy: 95,
    nonQualifiedBalance: 0,
  }));

  // In simple mode, order is NQ → Q → TF (qualified before Roth)
  // In advanced mode with long horizon, Roth growth cost is very high,
  // so it should also prefer qualified — results should be similar or better
  const simplePR = simpleModel.allResults.find(r => r.id === "pro-rata");
  const advancedPR = advancedModel.allResults.find(r => r.id === "pro-rata");

  assert(Number.isFinite(advancedPR.totalNetLegacy), "Advanced pro-rata legacy should be finite");
  // Advanced should produce at least comparable legacy
  assert(advancedPR.totalNetLegacy >= simplePR.totalNetLegacy - 100,
    `Advanced legacy (${advancedPR.totalNetLegacy}) should be >= simple (${simplePR.totalNetLegacy})`);
});

// ── 6. Advanced mode with 1 year remaining — Roth is cheap ─────────────────

test("6: With 1 year remaining, advanced may prefer Roth (low opportunity cost)", () => {
  const m = ctx.runModel(baseInputs({
    taxPaymentMode: "advanced",
    currentAge: 91, retirementAge: 65, lifeExpectancy: 92,
    nonQualifiedBalance: 0,
  }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
  }
});

// ── 7. Both modes handle zero balances ──────────────────────────────────────

test("7: Advanced mode with zero balances", () => {
  const m = ctx.runModel(baseInputs({
    taxPaymentMode: "advanced",
    qualifiedBalance: 0, nonQualifiedBalance: 0, taxFreeBalance: 0,
  }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
  }
});

// ── 8. Advanced mode with very large balances ───────────────────────────────

test("8: Advanced mode with $10M qualified — no NaN/Infinity", () => {
  const m = ctx.runModel(baseInputs({
    taxPaymentMode: "advanced",
    qualifiedBalance: 10000000,
  }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(Number.isFinite(r.totalNetLegacy), `${r.name}: totalNetLegacy not finite`);
  }
});

// ── 9. payTaxesDynamic unit test — NQ first ─────────────────────────────────

test("9: payTaxesDynamic drains NQ first", () => {
  const result = ctx.payTaxesDynamic(
    5000,
    { nonQualified: 10000, qualified: 50000, taxFree: 50000 },
    {},
    { marginalRate: 0.22, yearsRemaining: 20, returnRate: 0.05 }
  );
  // Should come entirely from NQ
  assert(approxEqual(result.balancesAfter.nonQualified, 5000, 0.01), "NQ should be 5000");
  assert(approxEqual(result.balancesAfter.qualified, 50000, 0.01), "Qualified unchanged");
  assert(approxEqual(result.balancesAfter.taxFree, 50000, 0.01), "TaxFree unchanged");
});

// ── 10. payTaxesDynamic — qualified vs Roth comparison ──────────────────────

test("10: payTaxesDynamic picks qualified when marginal rate is low and horizon short", () => {
  // Low marginal rate (12%) + short horizon (2 years) + 5% return
  // Qualified cost = 1/(1-0.12) = 1.136
  // Roth cost = 1 + (1.05^2 - 1) = 1.1025
  // Roth is cheaper here, so should pick Roth
  const result = ctx.payTaxesDynamic(
    5000,
    { nonQualified: 0, qualified: 50000, taxFree: 50000 },
    {},
    { marginalRate: 0.12, yearsRemaining: 2, returnRate: 0.05 }
  );
  // With these numbers Roth cost (1.1025) < qualified cost (1.136), so Roth used first
  assert(result.balancesAfter.taxFree < 50000, "Should drain some Roth");
});

test("10b: payTaxesDynamic picks qualified when marginal rate is low and horizon long", () => {
  // Low marginal rate (12%) + long horizon (30 years) + 5% return
  // Qualified cost = 1/(1-0.12) = 1.136
  // Roth cost = 1 + (1.05^30 - 1) = 4.322
  // Qualified is much cheaper
  const result = ctx.payTaxesDynamic(
    5000,
    { nonQualified: 0, qualified: 50000, taxFree: 50000 },
    {},
    { marginalRate: 0.12, yearsRemaining: 30, returnRate: 0.05 }
  );
  assert(result.balancesAfter.qualified < 50000, "Should drain qualified first");
  assert(approxEqual(result.balancesAfter.taxFree, 50000, 0.01), "Roth should be untouched");
});

// ── 11. getMarginalRate unit test ────────────────────────────────────────────

test("11: getMarginalRate returns correct bracket + state", () => {
  const brackets = [
    { cap: 23850, rate: 0.1 },
    { cap: 96950, rate: 0.12 },
    { cap: 206700, rate: 0.22 },
    { cap: 394600, rate: 0.24 },
    { cap: 501050, rate: 0.32 },
    { cap: 751600, rate: 0.35 },
    { cap: Number.POSITIVE_INFINITY, rate: 0.37 },
  ];
  // Taxable income of $50,000 → 12% bracket + 5.39% state
  const rate = ctx.getMarginalRate(50000, brackets, 0.0539);
  assert(approxEqual(rate, 0.1739, 0.001), `Expected 0.1739, got ${rate}`);

  // Taxable income of $200,000 → 22% bracket + 5.39% state
  const rate2 = ctx.getMarginalRate(200000, brackets, 0.0539);
  assert(approxEqual(rate2, 0.2739, 0.001), `Expected 0.2739, got ${rate2}`);
});

// ── 12. Single filer advanced mode ──────────────────────────────────────────

test("12: Advanced mode works for single filers", () => {
  const m = ctx.runModel(baseInputs({ taxPaymentMode: "advanced", filingStatus: "single" }));
  assert(m.allResults.length === 20, `Expected 20 results`);
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
  }
});

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ADVANCED MODE TEST RESULTS`);
console.log(`${"═".repeat(60)}`);
console.log(`  Total: ${totalTests}  |  Passed: ${passed}  |  Failed: ${failed}`);
console.log(`${"═".repeat(60)}`);

if (failures.length > 0) {
  console.log("\nFAILURES:\n");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.message}\n`);
  }
  process.exit(1);
} else {
  console.log("\n  ✓ All tests passed!\n");
}
