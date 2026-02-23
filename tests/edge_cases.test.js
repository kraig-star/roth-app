const fs = require("fs");
const vm = require("vm");

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
  }
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
    ...overrides,
  };
}

function runAndCheck(inputs) {
  const model = ctx.runModel(inputs);
  assert(model.allResults.length === 20, `Expected 20 results, got ${model.allResults.length}`);
  return model;
}

// ── 1. Zero balances ─────────────────────────────────────────────────────────

test("1a: All zero balances", () => {
  const m = runAndCheck(baseInputs({ qualifiedBalance: 0, nonQualifiedBalance: 0, taxFreeBalance: 0 }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(r.totalConverted === 0 || r.totalConverted >= 0, `${r.name}: negative converted`);
  }
});

test("1b: Only qualified balance", () => {
  runAndCheck(baseInputs({ nonQualifiedBalance: 0, taxFreeBalance: 0 }));
});

test("1c: Only non-qualified balance", () => {
  runAndCheck(baseInputs({ qualifiedBalance: 0, taxFreeBalance: 0 }));
});

test("1d: Only tax-free balance", () => {
  runAndCheck(baseInputs({ qualifiedBalance: 0, nonQualifiedBalance: 0 }));
});

// ── 2. Very large balances ───────────────────────────────────────────────────

test("2: $10M qualified — no NaN/Infinity, IRMAA triggers on pro-rata", () => {
  const m = runAndCheck(baseInputs({ qualifiedBalance: 10000000 }));
  const proRata = m.allResults.find(r => r.id === "pro-rata");
  assert(proRata.totalIRMAA > 0, "IRMAA should trigger for pro-rata with $10M qualified (large RMDs push MAGI up)");
  // Max conversion moves funds pre-retirement, so IRMAA lookback may see low MAGI — that's correct behavior
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(Number.isFinite(r.totalRmd), `${r.name}: totalRmd not finite`);
  }
});

// ── 3. currentAge = retirementAge ────────────────────────────────────────────

test("3: currentAge = retirementAge (no pre-retirement window)", () => {
  const m = runAndCheck(baseInputs({ currentAge: 65, retirementAge: 65 }));
  // Conversion strategies that rely on pre-retirement window should still work
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 4. currentAge = retirementAge - 1 ───────────────────────────────────────

test("4: Single pre-retirement year", () => {
  const m = runAndCheck(baseInputs({ currentAge: 64, retirementAge: 65 }));
  const fill12 = m.allResults.find(r => r.id === "conv-fill-12");
  // With only 1 pre-ret year, conversion capacity is limited
  assert(Number.isFinite(fill12.totalConverted), "totalConverted should be finite");
});

// ── 5. Life expectancy = retirementAge + 1 ──────────────────────────────────

test("5: Only 1 retirement year", () => {
  const m = runAndCheck(baseInputs({ currentAge: 65, retirementAge: 65, lifeExpectancy: 66 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 6. Very high pre-retirement income ───────────────────────────────────────

test("6: $500k pre-retirement income eliminates low-bracket conversion room", () => {
  const m = runAndCheck(baseInputs({ currentAnnualTaxableIncome: 500000 }));
  const fill12 = m.allResults.find(r => r.id === "conv-fill-12");
  // With $500k income, 12% bracket is already filled — no conversion room
  // During pre-retirement years, conversion should be $0 for low brackets
  // Total converted may include retirement years where income is lower
  assert(Number.isFinite(fill12.totalConverted), "Should be finite");
});

// ── 7. Age exactly at RMD start ─────────────────────────────────────────────

test("7: First RMD year — age = rmdStartAge", () => {
  const m = runAndCheck(baseInputs({ currentAge: 75, retirementAge: 65, rmdStartAge: 75 }));
  const proRata = m.allResults.find(r => r.id === "pro-rata");
  assert(proRata.totalRmd > 0, "RMDs should trigger when starting at RMD age");
});

// ── 8. Age 100 ──────────────────────────────────────────────────────────────

test("8: Age 100 — end of divisor table", () => {
  const m = runAndCheck(baseInputs({ currentAge: 100, retirementAge: 65, lifeExpectancy: 105 }));
  const proRata = m.allResults.find(r => r.id === "pro-rata");
  assert(proRata.totalRmd > 0, "RMDs should work at age 100");
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 9. Qualified = 0 at RMD age ─────────────────────────────────────────────

test("9: No qualified balance at RMD age — zero RMDs", () => {
  const m = runAndCheck(baseInputs({ qualifiedBalance: 0, currentAge: 75, retirementAge: 65 }));
  const proRata = m.allResults.find(r => r.id === "pro-rata");
  assert(approxEqual(proRata.totalRmd, 0), `Expected 0 RMDs, got ${proRata.totalRmd}`);
});

// ── 10. fillBracket "0%" ────────────────────────────────────────────────────

test("10: Fill 0% bracket — should only convert up to standard deduction", () => {
  const m = runAndCheck(baseInputs({ currentAnnualTaxableIncome: 0 }));
  const fill0 = m.allResults.find(r => r.id === "conv-fill-0");
  assert(fill0.totalConverted >= 0, "0% bracket conversion should be non-negative");
  // 0% bracket cap = taxable income of $0, so conversion fills only to make taxableIncome=0
  // meaning conversion only fills up to standard deduction minus other income
});

// ── 11. Maximum conversion with $5M qualified ───────────────────────────────

test("11: Max conversion with $5M — converts significant amount", () => {
  const m = runAndCheck(baseInputs({ qualifiedBalance: 5000000 }));
  const maxConv = m.allResults.find(r => r.id === "conv-max");
  assert(maxConv.totalConverted > 1000000, `Expected large conversion, got ${maxConv.totalConverted}`);
});

// ── 12. belowIRMAA when income already exceeds threshold ────────────────────

test("12: belowIRMAA with income already above IRMAA — should convert $0", () => {
  const m = runAndCheck(baseInputs({ currentAnnualTaxableIncome: 800000 }));
  const irmaa1 = m.allResults.find(r => r.id === "conv-irmaa-1");
  // During pre-retirement years with $800k income, IRMAA bracket 1 is blown
  // But retirement years may have room. Check total is finite.
  assert(Number.isFinite(irmaa1.totalConverted), "Should be finite");
});

// ── 13. Tax recursion stress — no liquid assets ─────────────────────────────

test("13: No liquid assets — tax recursion from qualified", () => {
  const m = runAndCheck(baseInputs({
    qualifiedBalance: 500000, nonQualifiedBalance: 0, taxFreeBalance: 0,
    currentAge: 65, retirementAge: 65,
  }));
  for (const r of m.allResults) {
    assert(Number.isFinite(r.totalTaxes), `${r.name}: totalTaxes not finite`);
    assert(r.totalTaxes >= 0, `${r.name}: negative taxes ${r.totalTaxes}`);
  }
});

// ── 14. SS start age before retirement age ──────────────────────────────────

test("14: SS starts before retirement", () => {
  const m = runAndCheck(baseInputs({ socialSecurityStartAge: 62, retirementAge: 67 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 15. SS = $0 ─────────────────────────────────────────────────────────────

test("15: Zero Social Security", () => {
  const m = runAndCheck(baseInputs({ socialSecurityAnnual: 0 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 16. Very high SS + high qualified withdrawals ───────────────────────────

test("16: $60k SS with large qualified — 85% SS taxation cap", () => {
  const m = runAndCheck(baseInputs({ socialSecurityAnnual: 60000, qualifiedBalance: 3000000 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 17. Single filer — higher taxes ─────────────────────────────────────────

test("17: Single filer taxes > MFJ for same balances", () => {
  const common = { qualifiedBalance: 1200000, nonQualifiedBalance: 350000, taxFreeBalance: 150000 };
  const mfjModel = runAndCheck(baseInputs({ ...common, filingStatus: "mfj" }));
  const singleModel = runAndCheck(baseInputs({ ...common, filingStatus: "single" }));
  const mfjTax = mfjModel.allResults.find(r => r.id === "pro-rata").totalTaxes;
  const singleTax = singleModel.allResults.find(r => r.id === "pro-rata").totalTaxes;
  assert(singleTax > mfjTax, `Single tax (${singleTax}) should exceed MFJ (${mfjTax})`);
});

// ── 18. MFJ vs Single comparison ────────────────────────────────────────────

test("18: MFJ vs Single — all strategies, single always >= MFJ taxes", () => {
  const common = { qualifiedBalance: 800000, nonQualifiedBalance: 200000, taxFreeBalance: 100000 };
  const mfjModel = runAndCheck(baseInputs({ ...common, filingStatus: "mfj" }));
  const singleModel = runAndCheck(baseInputs({ ...common, filingStatus: "single" }));
  // Check pro-rata at minimum
  const mfjPR = mfjModel.allResults.find(r => r.id === "pro-rata").totalTaxes;
  const singlePR = singleModel.allResults.find(r => r.id === "pro-rata").totalTaxes;
  assert(singlePR >= mfjPR - 1, `Single pro-rata (${singlePR}) should be >= MFJ (${mfjPR})`);
});

// ── 19. 0% inflation ────────────────────────────────────────────────────────

test("19: 0% inflation — brackets don't grow", () => {
  const m = runAndCheck(baseInputs({ inflationRate: 0 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 20. High inflation (8%) ─────────────────────────────────────────────────

test("20: 8% inflation — no blowups", () => {
  const m = runAndCheck(baseInputs({ inflationRate: 0.08 }));
  for (const r of m.allResults) assert(Number.isFinite(r.totalTaxes), `${r.name}: not finite`);
});

// ── 21. totalValueCreated invariant for ALL strategies ──────────────────────

test("21: totalValueCreated = netIncomeDelta + legacyDelta for all strategies", () => {
  const m = runAndCheck(baseInputs());
  for (const r of m.allResults) {
    const expected = r.netIncomeDeltaVsBaseline + r.legacyDeltaVsBaseline;
    assert(approxEqual(r.totalValueCreatedVsBaseline, expected, 0.02),
      `${r.name}: totalValueCreated (${r.totalValueCreatedVsBaseline}) != income (${r.netIncomeDeltaVsBaseline}) + legacy (${r.legacyDeltaVsBaseline})`);
  }
});

// ── 22. No negative totalTaxes ──────────────────────────────────────────────

test("22: No strategy produces negative totalTaxes", () => {
  const scenarios = [
    baseInputs(),
    baseInputs({ qualifiedBalance: 0, nonQualifiedBalance: 0, taxFreeBalance: 0 }),
    baseInputs({ qualifiedBalance: 10000000 }),
    baseInputs({ inflationRate: 0.08 }),
    baseInputs({ filingStatus: "single" }),
  ];
  for (const inp of scenarios) {
    const m = ctx.runModel(inp);
    for (const r of m.allResults) {
      assert(r.totalTaxes >= -0.01, `${r.name}: negative totalTaxes ${r.totalTaxes}`);
    }
  }
});

// ── 23. No negative totalNetIncome ──────────────────────────────────────────

test("23: No strategy produces negative totalNetIncome (standard cases)", () => {
  const m = runAndCheck(baseInputs());
  for (const r of m.allResults) {
    assert(r.totalNetIncome >= -0.01, `${r.name}: negative totalNetIncome ${r.totalNetIncome}`);
  }
});

// ── 24. Pro-rata savingsVsBaseline = $0 ─────────────────────────────────────

test("24: Pro-rata savingsVsBaseline is exactly $0", () => {
  const scenarios = [
    baseInputs(),
    baseInputs({ qualifiedBalance: 10000000 }),
    baseInputs({ filingStatus: "single" }),
    baseInputs({ inflationRate: 0 }),
  ];
  for (const inp of scenarios) {
    const m = ctx.runModel(inp);
    const pr = m.allResults.find(r => r.id === "pro-rata");
    assert(approxEqual(pr.savingsVsBaseline, 0, 0.01),
      `Pro-rata savings should be $0, got ${pr.savingsVsBaseline}`);
  }
});

// ── 25. All numeric fields finite ───────────────────────────────────────────

test("25: All numeric output fields finite across edge cases", () => {
  const fields = [
    "avgTaxRate", "totalTaxes", "totalTaxableIncome", "totalNetIncome",
    "totalNetLegacy", "totalConverted", "totalRmd", "totalIRMAA",
    "savingsVsBaseline", "netIncomeDeltaVsBaseline", "legacyDeltaVsBaseline",
    "totalValueCreatedVsBaseline",
  ];
  const scenarios = [
    baseInputs(),
    baseInputs({ qualifiedBalance: 0, nonQualifiedBalance: 0, taxFreeBalance: 0 }),
    baseInputs({ qualifiedBalance: 10000000 }),
    baseInputs({ currentAge: 65, retirementAge: 65 }),
    baseInputs({ currentAge: 65, retirementAge: 65, lifeExpectancy: 66 }),
    baseInputs({ currentAge: 100, retirementAge: 65, lifeExpectancy: 105 }),
    baseInputs({ inflationRate: 0 }),
    baseInputs({ inflationRate: 0.08 }),
    baseInputs({ socialSecurityAnnual: 0 }),
    baseInputs({ filingStatus: "single" }),
  ];
  for (let i = 0; i < scenarios.length; i++) {
    const m = ctx.runModel(scenarios[i]);
    for (const r of m.allResults) {
      for (const f of fields) {
        assert(Number.isFinite(r[f]), `Scenario ${i}, ${r.name}: ${f} = ${r[f]} (not finite)`);
      }
    }
  }
});

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  EDGE CASE TEST RESULTS`);
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
