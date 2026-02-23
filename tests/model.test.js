const fs = require("fs");
const vm = require("vm");

function makeGenericElement() {
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    children: [],
    classList: { add() {}, remove() {} },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener() {},
  };
}

function loadAppContext() {
  const code = fs.readFileSync("/Users/kraigguffey/Documents/ROTH App/app.js", "utf8");

  const formEl = makeGenericElement();

  const refs = {
    "#estimator-form": formEl,
    "#results": makeGenericElement(),
    "#topStrategies": makeGenericElement(),
    "#summaryText": makeGenericElement(),
    "#resultsTableBody": makeGenericElement(),
  };

  const context = {
    console,
    window: { alert() {} },
    document: {
      querySelector(selector) {
        return refs[selector] || makeGenericElement();
      },
      createElement() {
        return {
          value: "",
          textContent: "",
          selected: false,
        };
      },
    },
    FormData: class MockFormData {
      constructor(map) {
        this.map = map || new Map();
      }
      get(key) {
        return this.map.get(key);
      }
    },
    Intl,
    Number,
    String,
    Math,
  };

  vm.createContext(context);
  vm.runInContext(code, context, { filename: "app.js" });
  return context;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual, expected, epsilon = 0.01) {
  return Math.abs(actual - expected) <= epsilon;
}

function runTests() {
  const ctx = loadAppContext();
  const mfj = {
    standardDeduction: 30000,
    taxableSocialSecurity: { base1: 32000, base2: 44000, addAmount: 6000 },
    irmaaThresholds: [212000, 266000, 334000, 400000, 750000],
    irmaaAnnualSurcharge: [2105, 5287, 8469, 11652, 12713],
    brackets: [
      { cap: 23850, rate: 0.1 },
      { cap: 96950, rate: 0.12 },
      { cap: 206700, rate: 0.22 },
      { cap: 394600, rate: 0.24 },
      { cap: 501050, rate: 0.32 },
      { cap: 751600, rate: 0.35 },
      { cap: Number.POSITIVE_INFINITY, rate: 0.37 },
    ],
  };
  const single = {
    standardDeduction: 15000,
    taxableSocialSecurity: { base1: 25000, base2: 34000, addAmount: 4500 },
    irmaaThresholds: [106000, 133000, 167000, 200000, 500000],
    irmaaAnnualSurcharge: [1052, 2644, 4235, 5826, 6356],
    brackets: [
      { cap: 11925, rate: 0.1 },
      { cap: 48475, rate: 0.12 },
      { cap: 103350, rate: 0.22 },
      { cap: 197300, rate: 0.24 },
      { cap: 250525, rate: 0.32 },
      { cap: 626350, rate: 0.35 },
      { cap: Number.POSITIVE_INFINITY, rate: 0.37 },
    ],
  };

  // 1) Strategy library coverage
  const strategies = ctx.buildStrategyLibrary();
  assert(strategies.length === 20, `Expected 20 strategies, got ${strategies.length}`);
  assert(strategies.some((s) => s.name === "Pro-Rata"), "Missing Pro-Rata");
  assert(
    strategies.some((s) => s.name === "Roth Conversions to fill 12% Brkt"),
    "Missing 12% conversion strategy"
  );
  assert(
    strategies.some((s) => s.name === "Roth Conversions below IRMAA Brkt 5"),
    "Missing IRMAA 5 strategy"
  );

  // 2) RMD age derivation
  assert(ctx.deriveRmdStartAge(1949, null) === 72, "Birth year 1949 should derive RMD age 72");
  assert(ctx.deriveRmdStartAge(1955, null) === 73, "Birth year 1955 should derive RMD age 73");
  assert(ctx.deriveRmdStartAge(1961, null) === 75, "Birth year 1961 should derive RMD age 75");
  assert(ctx.deriveRmdStartAge(1961, 74) === 74, "Override RMD age should win");

  // 3) Taxable Social Security sanity checks (MFJ config)
  const ssCase1 = ctx.calculateTaxableSocialSecurity(40000, 10000, mfj.taxableSocialSecurity);
  assert(approxEqual(ssCase1, 0), "Taxable SS should be 0 when provisional income is below base1");

  const ssCase2 = ctx.calculateTaxableSocialSecurity(40000, 20000, mfj.taxableSocialSecurity);
  assert(approxEqual(ssCase2, 4000), `Expected taxable SS 4000, got ${ssCase2}`);

  const ssCase3 = ctx.calculateTaxableSocialSecurity(40000, 60000, mfj.taxableSocialSecurity);
  assert(approxEqual(ssCase3, 34000), `Expected taxable SS 34000, got ${ssCase3}`);

  // 4) IRMAA lookback behavior
  const irmaaNone = ctx.calculateIRMAACost({
    age: 64,
    yearIndex: 4,
    currentMAGI: 900000,
    magiHistory: [100000, 500000, 500000, 500000],
    irmaaThresholds: mfj.irmaaThresholds,
    irmaaAnnualSurcharge: mfj.irmaaAnnualSurcharge,
  });
  assert(approxEqual(irmaaNone, 0), "IRMAA should be 0 for age < 65");

  const irmaaWithLookback = ctx.calculateIRMAACost({
    age: 67,
    yearIndex: 4,
    currentMAGI: 100000,
    magiHistory: [100000, 200000, 500000, 100000],
    irmaaThresholds: mfj.irmaaThresholds,
    irmaaAnnualSurcharge: mfj.irmaaAnnualSurcharge,
  });
  // yearIndex=4 -> lookback yearIndex=2 -> MAGI 500000 -> surcharge tier 4 for MFJ
  assert(
    approxEqual(irmaaWithLookback, mfj.irmaaAnnualSurcharge[3]),
    "IRMAA should use 2-year lookback MAGI tier"
  );

  // 5) Tax recursion when taxes are paid from qualified assets
  const evalWithRecursion = ctx.evaluateYearWithConversion({
    conversionAmount: 100000,
    baseNonSSOrdinary: 0,
    socialSecurityGross: 0,
    balancesAfterConversion: { qualified: 100000, nonQualified: 0, taxFree: 0 },
    inputs: { stateTaxRate: 0 },
    age: 65,
    yearIndex: 0,
    magiHistory: [],
    taxConfig: single,
    standardDeduction: single.standardDeduction,
    brackets: single.brackets,
    irmaaThresholds: single.irmaaThresholds,
    irmaaAnnualSurcharge: single.irmaaAnnualSurcharge,
  });
  const directTaxNoRecursion = ctx.computeTaxComponents({
    nonSSOrdinaryIncome: 100000,
    socialSecurityGross: 0,
    filingStatusConfig: single,
    standardDeduction: single.standardDeduction,
    brackets: single.brackets,
    stateTaxRate: 0,
    age: 65,
    yearIndex: 0,
    magiHistory: [],
    irmaaThresholds: single.irmaaThresholds,
    irmaaAnnualSurcharge: single.irmaaAnnualSurcharge,
  }).totalTax;

  assert(
    evalWithRecursion.qualifiedTaxPayment > 0,
    "Qualified tax payment recursion should trigger when liquid buckets are 0"
  );
  assert(
    evalWithRecursion.totalTax > directTaxNoRecursion,
    "Recursive tax should exceed direct tax when tax itself is withdrawn from qualified assets"
  );

  // 6) End-to-end model smoke test
  const model = ctx.runModel({
    qualifiedBalance: 1200000,
    nonQualifiedBalance: 350000,
    taxFreeBalance: 150000,
    currentAge: 55,
    retirementAge: 65,
    lifeExpectancy: 92,
    birthYear: 1961,
    rmdStartAgeOverride: null,
    rmdStartAge: 75,
    filingStatus: "mfj",
    annualPaycheck: 90000,
    socialSecurityAnnual: 42000,
    socialSecurityStartAge: 67,
    qualifiedReturnRate: 0.05,
    nonQualifiedReturnRate: 0.045,
    taxFreeReturnRate: 0.05,
    inflationRate: 0.025,
    stateTaxRate: 0.0539,
    nonQualifiedTaxableRatio: 0.3,
  });

  assert(model.baseline && model.baseline.id === "pro-rata", "Baseline should be Pro-Rata");
  assert(model.allResults.length === 20, `Expected 20 results, got ${model.allResults.length}`);
  assert(model.top3.length === 3, `Expected top3 length 3, got ${model.top3.length}`);

  for (const result of model.allResults) {
    const numericFields = [
      "avgTaxRate",
      "totalTaxes",
      "totalTaxableIncome",
      "totalNetIncome",
      "totalNetLegacy",
      "totalConverted",
      "totalRmd",
      "totalIRMAA",
      "savingsVsBaseline",
      "netIncomeDeltaVsBaseline",
      "legacyDeltaVsBaseline",
      "totalValueCreatedVsBaseline",
    ];
    for (const field of numericFields) {
      assert(Number.isFinite(result[field]), `${result.name}: ${field} is not finite`);
    }
    assert(
      approxEqual(
        result.totalValueCreatedVsBaseline,
        result.netIncomeDeltaVsBaseline + result.legacyDeltaVsBaseline,
        0.01
      ),
      `${result.name}: total value created should equal income increase + legacy increase`
    );
  }

  for (let i = 1; i < model.top3.length; i += 1) {
    const prev = model.top3[i - 1];
    const curr = model.top3[i];
    assert(
      prev.totalValueCreatedVsBaseline >= curr.totalValueCreatedVsBaseline - 1e-9,
      "Top 3 should be sorted by highest total value created first"
    );
  }

  // 7) Current-age modeling should create a pre-retirement conversion window.
  const withPreRetWindow = ctx.runModel({
    qualifiedBalance: 1200000,
    nonQualifiedBalance: 350000,
    taxFreeBalance: 150000,
    currentAge: 55,
    retirementAge: 65,
    lifeExpectancy: 92,
    birthYear: 1961,
    rmdStartAgeOverride: null,
    rmdStartAge: 75,
    filingStatus: "mfj",
    annualPaycheck: 84000,
    socialSecurityAnnual: 42000,
    socialSecurityStartAge: 67,
    qualifiedReturnRate: 0.05,
    nonQualifiedReturnRate: 0.045,
    taxFreeReturnRate: 0.05,
    inflationRate: 0.025,
    stateTaxRate: 0.0539,
    nonQualifiedTaxableRatio: 0.3,
  });

  const fill12 = withPreRetWindow.allResults.find(
    (result) => result.name === "Roth Conversions to fill 12% Brkt"
  );
  assert(fill12, "Expected to find 12% conversion result");
  assert(fill12.totalConverted > 0, "12% conversion should convert dollars with pre-retirement years");
  assert(
    fill12.savingsVsBaseline > 0,
    "12% conversion should improve taxes versus Pro-Rata in this pre-retirement scenario"
  );

  // 8) Higher pre-retirement taxable income should reduce conversion capacity.
  const lowIncomeWindow = ctx.runModel({
    qualifiedBalance: 1200000,
    nonQualifiedBalance: 350000,
    taxFreeBalance: 150000,
    currentAge: 55,
    retirementAge: 65,
    lifeExpectancy: 92,
    birthYear: 1961,
    rmdStartAgeOverride: null,
    rmdStartAge: 75,
    filingStatus: "mfj",
    annualPaycheck: 84000,
    currentAnnualTaxableIncome: 0,
    socialSecurityAnnual: 42000,
    socialSecurityStartAge: 67,
    qualifiedReturnRate: 0.05,
    nonQualifiedReturnRate: 0.045,
    taxFreeReturnRate: 0.05,
    inflationRate: 0.025,
    stateTaxRate: 0.0539,
    nonQualifiedTaxableRatio: 0.3,
  });
  const highIncomeWindow = ctx.runModel({
    qualifiedBalance: 1200000,
    nonQualifiedBalance: 350000,
    taxFreeBalance: 150000,
    currentAge: 55,
    retirementAge: 65,
    lifeExpectancy: 92,
    birthYear: 1961,
    rmdStartAgeOverride: null,
    rmdStartAge: 75,
    filingStatus: "mfj",
    annualPaycheck: 84000,
    currentAnnualTaxableIncome: 180000,
    socialSecurityAnnual: 42000,
    socialSecurityStartAge: 67,
    qualifiedReturnRate: 0.05,
    nonQualifiedReturnRate: 0.045,
    taxFreeReturnRate: 0.05,
    inflationRate: 0.025,
    stateTaxRate: 0.0539,
    nonQualifiedTaxableRatio: 0.3,
  });

  const fill12LowIncome = lowIncomeWindow.allResults.find(
    (result) => result.name === "Roth Conversions to fill 12% Brkt"
  );
  const fill12HighIncome = highIncomeWindow.allResults.find(
    (result) => result.name === "Roth Conversions to fill 12% Brkt"
  );
  assert(fill12LowIncome && fill12HighIncome, "Expected 12% conversion results for both income cases");
  assert(
    fill12HighIncome.totalConverted < fill12LowIncome.totalConverted,
    "Higher current taxable income should reduce 12% bracket conversion capacity"
  );

  console.log("All tests passed.");
}

try {
  runTests();
} catch (error) {
  console.error("TEST FAILURE:", error.message);
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
}
