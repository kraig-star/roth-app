const BASELINE_STRATEGY_ID = "pro-rata";
const GEORGIA_STATE_CODE = "GA";
const GEORGIA_STATE_TAX_RATE = 0.0539;

const TAX_CONFIG_BY_STATUS = {
  mfj: {
    label: "Married Filing Jointly",
    standardDeduction: 30000,
    brackets: [
      { cap: 23200, rate: 0.1 },
      { cap: 94300, rate: 0.12 },
      { cap: 201050, rate: 0.22 },
      { cap: 383900, rate: 0.24 },
      { cap: 487450, rate: 0.32 },
      { cap: 731200, rate: 0.35 },
      { cap: Number.POSITIVE_INFINITY, rate: 0.37 },
    ],
    taxableSocialSecurity: { base1: 32000, base2: 44000, addAmount: 6000 },
    irmaaThresholds: [212000, 266000, 334000, 400000, 750000],
    // Annual household surcharge approximation (Part B + Part D).
    irmaaSurchargeAnnual: [2105, 5287, 8469, 11652, 12713],
  },
  single: {
    label: "Single",
    standardDeduction: 15000,
    brackets: [
      { cap: 11600, rate: 0.1 },
      { cap: 47150, rate: 0.12 },
      { cap: 100525, rate: 0.22 },
      { cap: 191950, rate: 0.24 },
      { cap: 243725, rate: 0.32 },
      { cap: 609350, rate: 0.35 },
      { cap: Number.POSITIVE_INFINITY, rate: 0.37 },
    ],
    taxableSocialSecurity: { base1: 25000, base2: 34000, addAmount: 4500 },
    irmaaThresholds: [106000, 133000, 167000, 200000, 500000],
    irmaaSurchargeAnnual: [1052, 2644, 4235, 5826, 6356],
  },
};

const form = document.querySelector("#estimator-form");
const resultsSection = document.querySelector("#results");
const topStrategiesEl = document.querySelector("#topStrategies");
const summaryTextEl = document.querySelector("#summaryText");
const tableBodyEl = document.querySelector("#resultsTableBody");
const runStatusEl = document.querySelector("#runStatus");

if (form) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setRunStatus("Running strategy comparison...", "info");

    window.setTimeout(() => {
      try {
        const inputs = parseInputs(new FormData(form));
        if (inputs.lifeExpectancy <= inputs.currentAge) {
          setRunStatus("Life expectancy must be higher than current age.", "error");
          window.alert("Life expectancy must be higher than current age.");
          return;
        }
        if (inputs.retirementAge > inputs.lifeExpectancy) {
          setRunStatus("Retirement start age must be less than life expectancy.", "error");
          window.alert("Retirement start age must be less than life expectancy.");
          return;
        }
        if (inputs.lifeExpectancy <= inputs.retirementAge) {
          setRunStatus("Life expectancy must be higher than retirement start age.", "error");
          window.alert("Life expectancy must be higher than retirement start age.");
          return;
        }

        const model = runModel(inputs);
        renderResults(model, inputs);

        setRunStatus("Comparison complete. Scroll down for the top 3 strategies.", "success");
        resultsSection?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        console.error("Run Strategy failed:", error);
        setRunStatus(
          "Unable to run strategy comparison due to an unexpected error. Please refresh and try again.",
          "error"
        );
        window.alert("Unable to run strategy comparison. Please refresh and try again.");
      }
    }, 0);
  });
} else {
  console.error("Form #estimator-form not found. Strategy runner is not initialized.");
}

function setRunStatus(message, tone) {
  if (!runStatusEl) return;
  runStatusEl.hidden = !message;
  runStatusEl.textContent = message || "";
  runStatusEl.className = `run-status ${tone || ""}`.trim();
}

function parseInputs(formData) {
  const qualifiedBalance = toNumber(formData.get("qualifiedBalance"));
  const nonQualifiedBalance = toNumber(formData.get("nonQualifiedBalance"));
  const taxFreeBalance = toNumber(formData.get("taxFreeBalance"));
  const currentAgeInput = toNullableInt(formData.get("currentAge"));
  const retirementAge = Math.round(toNumber(formData.get("retirementAge")));
  const currentAge = currentAgeInput ?? retirementAge;
  const lifeExpectancy = Math.round(toNumber(formData.get("lifeExpectancy")));

  const annualPaycheckInput = toNumber(formData.get("annualPaycheck"));
  const annualPaycheck =
    annualPaycheckInput > 0
      ? annualPaycheckInput
      : (qualifiedBalance + nonQualifiedBalance + taxFreeBalance) * 0.04;

  const birthYear = toNullableInt(formData.get("birthYear"));
  const rmdStartAgeOverride = toNullableInt(formData.get("rmdStartAgeOverride"));
  const rmdStartAge = deriveRmdStartAge(birthYear, rmdStartAgeOverride);

  const socialSecurityAnnual = toNumber(formData.get("socialSecurityAnnual"));
  const socialSecurityStartAge = toNullableInt(formData.get("socialSecurityStartAge")) ?? 67;
  const currentAnnualTaxableIncome = toNumber(formData.get("currentAnnualTaxableIncome"));

  return {
    qualifiedBalance,
    nonQualifiedBalance,
    taxFreeBalance,
    currentAge,
    retirementAge,
    lifeExpectancy,
    birthYear,
    rmdStartAgeOverride,
    rmdStartAge,
    filingStatus: String(formData.get("filingStatus") || "mfj"),
    annualPaycheck,
    currentAnnualTaxableIncome,
    socialSecurityAnnual,
    socialSecurityStartAge,
    qualifiedReturnRate: pctToDecimal(formData.get("qualifiedReturnPct")),
    nonQualifiedReturnRate: pctToDecimal(formData.get("nonQualifiedReturnPct")),
    taxFreeReturnRate: pctToDecimal(formData.get("taxFreeReturnPct")),
    inflationRate: pctToDecimal(formData.get("inflationPct")),
    stateTaxRate: GEORGIA_STATE_TAX_RATE,
    nonQualifiedTaxableRatio: pctToDecimal(formData.get("nonQualifiedTaxablePct")),
  };
}

function deriveRmdStartAge(birthYear, overrideAge) {
  if (overrideAge && overrideAge >= 70 && overrideAge <= 80) {
    return overrideAge;
  }
  if (!birthYear) return 73;
  if (birthYear <= 1950) return 72;
  if (birthYear <= 1959) return 73;
  return 75;
}

function runModel(inputs) {
  const strategies = buildStrategyLibrary();
  const raw = strategies.map((strategy) => simulateStrategy(inputs, strategy));
  const baseline = raw.find((r) => r.id === BASELINE_STRATEGY_ID) || raw[0];

  const withComparisons = raw.map((result) => ({
    ...result,
    savingsVsBaseline: baseline.totalTaxes - result.totalTaxes,
    netIncomeDeltaVsBaseline: result.totalNetIncome - baseline.totalNetIncome,
    legacyDeltaVsBaseline: result.totalNetLegacy - baseline.totalNetLegacy,
    totalValueCreatedVsBaseline:
      (result.totalNetIncome - baseline.totalNetIncome) +
      (result.totalNetLegacy - baseline.totalNetLegacy),
  }));

  const sortByOutcome = (a, b) => {
    if (a.totalTaxes !== b.totalTaxes) return a.totalTaxes - b.totalTaxes;
    if (b.totalNetIncome !== a.totalNetIncome) return b.totalNetIncome - a.totalNetIncome;
    return b.totalNetLegacy - a.totalNetLegacy;
  };

  const top3 = [...withComparisons].sort(sortByOutcome).slice(0, 3);

  const best = top3[0] || null;
  const bestReasons = best ? generateBestReasons(best, baseline) : [];
  const hasBeatingAlternative = withComparisons.some(
    (r) => r.id !== baseline.id && r.totalTaxes < baseline.totalTaxes - 0.01
  );

  return {
    baseline,
    allResults: withComparisons,
    top3,
    best,
    bestReasons,
    hasBeatingAlternative,
  };
}

function buildStrategyLibrary() {
  const noConversion = { type: "none" };

  const orderStrategies = [
    { id: "pro-rata", name: "Pro-Rata", withdrawalPolicy: { mode: "proRata" } },
    {
      id: "ord-taxable-taxdeferred-taxfree",
      name: "Taxable, Tax-Deferred, Tax-Free",
      withdrawalPolicy: { mode: "ordered", order: ["nonQualified", "qualified", "taxFree"] },
    },
    {
      id: "ord-taxable-taxfree-taxdeferred",
      name: "Taxable, Tax-Free, Tax-Deferred",
      withdrawalPolicy: { mode: "ordered", order: ["nonQualified", "taxFree", "qualified"] },
    },
    {
      id: "ord-taxdeferred-taxable-taxfree",
      name: "Tax-Deferred, Taxable, Tax-Free",
      withdrawalPolicy: { mode: "ordered", order: ["qualified", "nonQualified", "taxFree"] },
    },
    {
      id: "ord-taxdeferred-taxfree-taxable",
      name: "Tax-Deferred, Tax-Free, Taxable",
      withdrawalPolicy: { mode: "ordered", order: ["qualified", "taxFree", "nonQualified"] },
    },
    {
      id: "ord-taxfree-taxdeferred-taxable",
      name: "Tax-Free, Tax-Deferred, Taxable",
      withdrawalPolicy: { mode: "ordered", order: ["taxFree", "qualified", "nonQualified"] },
    },
    {
      id: "ord-taxfree-taxable-taxdeferred",
      name: "Tax-Free, Taxable, Tax-Deferred",
      withdrawalPolicy: { mode: "ordered", order: ["taxFree", "nonQualified", "qualified"] },
    },
  ].map((strategy) => ({
    ...strategy,
    description: "Withdrawal sequencing only (no Roth conversions).",
    conversionPolicy: noConversion,
  }));

  const conversionStrategies = [
    { id: "conv-fill-0", name: "Roth Conversions to fill 0% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "0%" } },
    { id: "conv-fill-10", name: "Roth Conversions to fill 10% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "10%" } },
    { id: "conv-fill-12", name: "Roth Conversions to fill 12% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "12%" } },
    { id: "conv-irmaa-1", name: "Roth Conversions below IRMAA Brkt 1", conversionPolicy: { type: "belowIRMAA", bracket: 1 } },
    { id: "conv-fill-22", name: "Roth Conversions to fill 22% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "22%" } },
    { id: "conv-irmaa-2", name: "Roth Conversions below IRMAA Brkt 2", conversionPolicy: { type: "belowIRMAA", bracket: 2 } },
    { id: "conv-irmaa-3", name: "Roth Conversions below IRMAA Brkt 3", conversionPolicy: { type: "belowIRMAA", bracket: 3 } },
    { id: "conv-irmaa-4", name: "Roth Conversions below IRMAA Brkt 4", conversionPolicy: { type: "belowIRMAA", bracket: 4 } },
    { id: "conv-fill-24", name: "Roth Conversions to fill 24% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "24%" } },
    { id: "conv-fill-32", name: "Roth Conversions to fill 32% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "32%" } },
    { id: "conv-irmaa-5", name: "Roth Conversions below IRMAA Brkt 5", conversionPolicy: { type: "belowIRMAA", bracket: 5 } },
    { id: "conv-fill-35", name: "Roth Conversions to fill 35% Brkt", conversionPolicy: { type: "fillBracket", bracketLabel: "35%" } },
    { id: "conv-max", name: "Maximum Roth Conversion", conversionPolicy: { type: "maximum" } },
  ].map((strategy) => ({
    ...strategy,
    description: "Roth conversion strategy with pro-rata retirement withdrawals.",
    withdrawalPolicy: { mode: "proRata" },
  }));

  return [...orderStrategies, ...conversionStrategies];
}

function simulateStrategy(inputs, strategy) {
  const taxConfig = TAX_CONFIG_BY_STATUS[inputs.filingStatus] || TAX_CONFIG_BY_STATUS.mfj;
  const startAge = Math.max(0, Math.round(inputs.currentAge ?? inputs.retirementAge));
  const years = Math.max(1, inputs.lifeExpectancy - startAge + 1);

  let qualified = inputs.qualifiedBalance;
  let nonQualified = inputs.nonQualifiedBalance;
  let taxFree = inputs.taxFreeBalance;

  const magiHistory = [];

  let totalTaxes = 0;
  let totalTaxableIncome = 0;
  let totalNetIncome = 0;
  let totalNetLegacy = 0;
  let totalConverted = 0;
  let totalRmd = 0;
  let totalIRMAA = 0;
  let totalShortfall = 0;

  for (let yearIndex = 0; yearIndex < years; yearIndex += 1) {
    const age = startAge + yearIndex;
    const inflationFactor = Math.pow(1 + inputs.inflationRate, yearIndex);
    const discountFactor = inflationFactor;

    const paycheckNeed =
      age >= inputs.retirementAge ? inputs.annualPaycheck * inflationFactor : 0;
    const socialSecurityGross =
      age >= inputs.socialSecurityStartAge
        ? inputs.socialSecurityAnnual * inflationFactor
        : 0;
    const preRetirementOrdinaryIncome =
      age < inputs.retirementAge
        ? (inputs.currentAnnualTaxableIncome || 0) * inflationFactor
        : 0;

    qualified *= 1 + inputs.qualifiedReturnRate;
    nonQualified *= 1 + inputs.nonQualifiedReturnRate;
    taxFree *= 1 + inputs.taxFreeReturnRate;

    const standardDeduction = taxConfig.standardDeduction * inflationFactor;
    const brackets = taxConfig.brackets.map((b) => ({
      cap: Number.isFinite(b.cap) ? b.cap * inflationFactor : b.cap,
      rate: b.rate,
    }));
    const irmaaThresholds = taxConfig.irmaaThresholds.map((v) => v * inflationFactor);
    const irmaaAnnualSurcharge = taxConfig.irmaaSurchargeAnnual.map((v) => v * inflationFactor);

    const externalIncomeUsed = Math.min(paycheckNeed, socialSecurityGross);
    let remainingNeed = paycheckNeed - externalIncomeUsed;

    const rmdRequired = getRmdAmount(age, qualified, inputs.rmdStartAge);
    const forcedQualifiedWithdrawal = Math.min(qualified, rmdRequired);
    qualified -= forcedQualifiedWithdrawal;
    totalRmd += forcedQualifiedWithdrawal / discountFactor;

    const usedRmdForSpending = Math.min(remainingNeed, forcedQualifiedWithdrawal);
    remainingNeed -= usedRmdForSpending;
    const excessRmdCash = forcedQualifiedWithdrawal - usedRmdForSpending;

    const spendingResult = withdrawForSpending(
      strategy.withdrawalPolicy,
      { qualified, nonQualified, taxFree },
      remainingNeed
    );

    qualified = spendingResult.balancesAfter.qualified;
    nonQualified = spendingResult.balancesAfter.nonQualified;
    taxFree = spendingResult.balancesAfter.taxFree;

    const qualifiedWithdrawalForSpending =
      forcedQualifiedWithdrawal + spendingResult.withdrawals.qualified;
    const nonQualifiedWithdrawalForSpending = spendingResult.withdrawals.nonQualified;
    const fundedFromPortfolio = usedRmdForSpending + spendingResult.fundedAmount;

    remainingNeed -= spendingResult.fundedAmount;
    const annualShortfall = Math.max(0, remainingNeed);
    totalShortfall += annualShortfall / discountFactor;

    const annualGrossIncome =
      externalIncomeUsed + fundedFromPortfolio + preRetirementOrdinaryIncome;

    if (excessRmdCash > 0) {
      nonQualified += excessRmdCash;
    }

    const baseNonSSOrdinary =
      preRetirementOrdinaryIncome +
      qualifiedWithdrawalForSpending +
      nonQualifiedWithdrawalForSpending * inputs.nonQualifiedTaxableRatio;

    const availableConversion = Math.max(0, qualified);
    const conversionAmount = determineConversionAmount({
      strategy,
      availableConversion,
      inputs,
      age,
      yearIndex,
      baseNonSSOrdinary,
      socialSecurityGross,
      balancesAfterSpending: { qualified, nonQualified, taxFree },
      magiHistory,
      taxConfig,
      standardDeduction,
      brackets,
      irmaaThresholds,
      irmaaAnnualSurcharge,
    });

    const afterConversion = {
      qualified: Math.max(0, qualified - conversionAmount),
      nonQualified,
      taxFree: taxFree + conversionAmount,
    };

    const evaluated = evaluateYearWithConversion({
      conversionAmount,
      baseNonSSOrdinary,
      socialSecurityGross,
      balancesAfterConversion: afterConversion,
      inputs,
      age,
      yearIndex,
      magiHistory,
      taxConfig,
      standardDeduction,
      brackets,
      irmaaThresholds,
      irmaaAnnualSurcharge,
    });

    const taxPayment = payTaxesFromBalances(
      evaluated.totalTax,
      afterConversion,
      ["nonQualified", "taxFree", "qualified"]
    );

    qualified = taxPayment.balancesAfter.qualified;
    nonQualified = taxPayment.balancesAfter.nonQualified;
    taxFree = taxPayment.balancesAfter.taxFree;

    const finalShortfall = annualShortfall + Math.max(0, taxPayment.unpaidTax);
    if (taxPayment.unpaidTax > 0) {
      totalShortfall += taxPayment.unpaidTax / discountFactor;
    }

    const annualNetIncome = annualGrossIncome - evaluated.totalTax;
    totalNetIncome += annualNetIncome / discountFactor;

    magiHistory.push(evaluated.magi);

    totalTaxes += evaluated.totalTax / discountFactor;
    totalTaxableIncome += evaluated.taxableIncome / discountFactor;
    totalIRMAA += evaluated.irmaaCost / discountFactor;
    totalConverted += conversionAmount / discountFactor;

    if (finalShortfall > 0 && annualNetIncome > 0) {
      // no-op: already captured through reduced annualNetIncome and tax shortfall handling.
    }
  }

  const legacyDiscount = Math.pow(1 + inputs.inflationRate, Math.max(0, years - 1));
  totalNetLegacy = (qualified + nonQualified + taxFree) / legacyDiscount;

  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    avgTaxRate: totalTaxableIncome > 0 ? totalTaxes / totalTaxableIncome : 0,
    totalTaxes,
    totalTaxableIncome,
    totalNetIncome,
    totalNetLegacy,
    totalConverted,
    totalRmd,
    totalIRMAA,
    totalShortfall,
  };
}

function determineConversionAmount(context) {
  const { strategy, availableConversion } = context;
  if (availableConversion <= 0) return 0;

  const policy = strategy.conversionPolicy || { type: "none" };
  if (policy.type === "none") return 0;
  if (policy.type === "maximum") return availableConversion;

  let capValue = null;
  let metricType = null;

  if (policy.type === "fillBracket") {
    metricType = "taxableIncome";
    capValue = getBracketTaxableCap(policy.bracketLabel, context.brackets);
  } else if (policy.type === "belowIRMAA") {
    metricType = "magi";
    capValue = getIRMAACap(policy.bracket, context.irmaaThresholds);
  }

  if (capValue == null) return 0;

  const lowEval = evaluateYearWithConversion({
    ...context,
    conversionAmount: 0,
    balancesAfterConversion: {
      qualified: context.balancesAfterSpending.qualified,
      nonQualified: context.balancesAfterSpending.nonQualified,
      taxFree: context.balancesAfterSpending.taxFree,
    },
  });
  if (getMetric(lowEval, metricType) > capValue) {
    return 0;
  }

  let low = 0;
  let high = availableConversion;
  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    const evalMid = evaluateYearWithConversion({
      ...context,
      conversionAmount: mid,
      balancesAfterConversion: {
        qualified: Math.max(0, context.balancesAfterSpending.qualified - mid),
        nonQualified: context.balancesAfterSpending.nonQualified,
        taxFree: context.balancesAfterSpending.taxFree + mid,
      },
    });

    const metric = getMetric(evalMid, metricType);
    if (metric <= capValue) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

function evaluateYearWithConversion({
  conversionAmount,
  baseNonSSOrdinary,
  socialSecurityGross,
  balancesAfterConversion,
  inputs,
  age,
  yearIndex,
  magiHistory,
  taxConfig,
  standardDeduction,
  brackets,
  irmaaThresholds,
  irmaaAnnualSurcharge,
}) {
  const nonQualifiedTaxFreeAvailable =
    balancesAfterConversion.nonQualified + balancesAfterConversion.taxFree;
  const maxQualifiedForTax = balancesAfterConversion.qualified;

  const nonSSBase = baseNonSSOrdinary + conversionAmount;

  let qualifiedTaxPayment = 0;
  let taxComputation = null;

  for (let i = 0; i < 24; i += 1) {
    taxComputation = computeTaxComponents({
      nonSSOrdinaryIncome: nonSSBase + qualifiedTaxPayment,
      socialSecurityGross,
      filingStatusConfig: taxConfig,
      standardDeduction,
      brackets,
      stateTaxRate: inputs.stateTaxRate,
      age,
      yearIndex,
      magiHistory,
      irmaaThresholds,
      irmaaAnnualSurcharge,
    });

    const requiredQualified = clamp(
      taxComputation.totalTax - nonQualifiedTaxFreeAvailable,
      0,
      maxQualifiedForTax
    );

    if (Math.abs(requiredQualified - qualifiedTaxPayment) < 0.01) {
      qualifiedTaxPayment = requiredQualified;
      break;
    }
    qualifiedTaxPayment = requiredQualified;
  }

  taxComputation = computeTaxComponents({
    nonSSOrdinaryIncome: nonSSBase + qualifiedTaxPayment,
    socialSecurityGross,
    filingStatusConfig: taxConfig,
    standardDeduction,
    brackets,
    stateTaxRate: inputs.stateTaxRate,
    age,
    yearIndex,
    magiHistory,
    irmaaThresholds,
    irmaaAnnualSurcharge,
  });

  return {
    ...taxComputation,
    qualifiedTaxPayment,
    conversionAmount,
  };
}

function computeTaxComponents({
  nonSSOrdinaryIncome,
  socialSecurityGross,
  filingStatusConfig,
  standardDeduction,
  brackets,
  stateTaxRate,
  age,
  yearIndex,
  magiHistory,
  irmaaThresholds,
  irmaaAnnualSurcharge,
}) {
  const taxableSS = calculateTaxableSocialSecurity(
    socialSecurityGross,
    nonSSOrdinaryIncome,
    filingStatusConfig.taxableSocialSecurity
  );

  const agi = nonSSOrdinaryIncome + taxableSS;
  const taxableIncome = Math.max(0, agi - standardDeduction);
  const federalTax = calculateBracketTax(taxableIncome, brackets);
  const stateTax = taxableIncome * stateTaxRate;
  const irmaaCost = calculateIRMAACost({
    age,
    yearIndex,
    currentMAGI: agi,
    magiHistory,
    irmaaThresholds,
    irmaaAnnualSurcharge,
  });

  return {
    taxableSS,
    magi: agi,
    taxableIncome,
    federalTax,
    stateTax,
    irmaaCost,
    totalTax: federalTax + stateTax + irmaaCost,
  };
}

function calculateTaxableSocialSecurity(ssGross, nonSSOrdinary, config) {
  if (ssGross <= 0) return 0;

  const provisional = nonSSOrdinary + ssGross * 0.5;
  if (provisional <= config.base1) return 0;

  if (provisional <= config.base2) {
    return Math.min(0.5 * (provisional - config.base1), 0.5 * ssGross);
  }

  return Math.min(
    0.85 * ssGross,
    0.85 * (provisional - config.base2) + Math.min(config.addAmount, 0.5 * ssGross)
  );
}

function calculateIRMAACost({
  age,
  yearIndex,
  currentMAGI,
  magiHistory,
  irmaaThresholds,
  irmaaAnnualSurcharge,
}) {
  if (age < 65) return 0;

  const lookbackIndex = yearIndex - 2;
  const lookbackMAGI = lookbackIndex >= 0 ? magiHistory[lookbackIndex] : currentMAGI;

  if (lookbackMAGI <= irmaaThresholds[0]) return 0;
  if (lookbackMAGI <= irmaaThresholds[1]) return irmaaAnnualSurcharge[0];
  if (lookbackMAGI <= irmaaThresholds[2]) return irmaaAnnualSurcharge[1];
  if (lookbackMAGI <= irmaaThresholds[3]) return irmaaAnnualSurcharge[2];
  if (lookbackMAGI <= irmaaThresholds[4]) return irmaaAnnualSurcharge[3];
  return irmaaAnnualSurcharge[4];
}

function getMetric(evaluation, metricType) {
  if (metricType === "magi") return evaluation.magi;
  return evaluation.taxableIncome;
}

function getBracketTaxableCap(label, indexedBrackets) {
  if (label === "0%") return 0;
  const byLabelOrder = {
    "10%": 0,
    "12%": 1,
    "22%": 2,
    "24%": 3,
    "32%": 4,
    "35%": 5,
  };
  const idx = byLabelOrder[label];
  if (idx == null || !indexedBrackets[idx]) return indexedBrackets[2].cap;
  return indexedBrackets[idx].cap;
}

function getIRMAACap(bracket, indexedThresholds) {
  const idx = Math.max(0, Math.min(4, bracket - 1));
  return indexedThresholds[idx] - 1;
}

function withdrawForSpending(withdrawalPolicy, balances, targetAmount) {
  const withdrawals = { qualified: 0, nonQualified: 0, taxFree: 0 };
  if (targetAmount <= 0) {
    return { withdrawals, fundedAmount: 0, balancesAfter: { ...balances } };
  }

  const after = { ...balances };
  let remaining = targetAmount;

  if (withdrawalPolicy.mode === "ordered") {
    for (const bucket of withdrawalPolicy.order) {
      if (remaining <= 0) break;
      const amount = Math.min(after[bucket], remaining);
      after[bucket] -= amount;
      withdrawals[bucket] += amount;
      remaining -= amount;
    }
  } else {
    let safety = 0;
    while (remaining > 0.01 && safety < 8) {
      safety += 1;
      const total = after.qualified + after.nonQualified + after.taxFree;
      if (total <= 0.01) break;

      let funded = 0;
      for (const bucket of ["qualified", "nonQualified", "taxFree"]) {
        if (after[bucket] <= 0) continue;
        const share = after[bucket] / total;
        const amount = Math.min(after[bucket], remaining * share);
        after[bucket] -= amount;
        withdrawals[bucket] += amount;
        funded += amount;
      }
      if (funded <= 0.01) break;
      remaining -= funded;
    }

    for (const bucket of ["qualified", "nonQualified", "taxFree"]) {
      if (remaining <= 0.01) break;
      const amount = Math.min(after[bucket], remaining);
      after[bucket] -= amount;
      withdrawals[bucket] += amount;
      remaining -= amount;
    }
  }

  const fundedAmount = Math.min(
    targetAmount,
    withdrawals.qualified + withdrawals.nonQualified + withdrawals.taxFree
  );
  return { withdrawals, fundedAmount, balancesAfter: after };
}

function payTaxesFromBalances(totalTax, balances, order) {
  let remainingTax = totalTax;
  const after = { ...balances };
  for (const bucket of order) {
    if (remainingTax <= 0) break;
    const amount = Math.min(after[bucket], remainingTax);
    after[bucket] -= amount;
    remainingTax -= amount;
  }
  return { balancesAfter: after, unpaidTax: Math.max(0, remainingTax) };
}

function getRmdAmount(age, qualifiedBalance, rmdStartAge) {
  if (age < rmdStartAge) return 0;
  const divisors = {
    72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0,
    79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0,
    86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8,
    93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4,
  };
  const lookupAge = clamp(age, 72, 100);
  const divisor = divisors[lookupAge];
  if (!divisor) return 0;
  return qualifiedBalance / divisor;
}

function calculateBracketTax(taxableIncome, brackets) {
  if (taxableIncome <= 0) return 0;
  let tax = 0;
  let prevCap = 0;
  for (const bracket of brackets) {
    if (taxableIncome <= prevCap) break;
    const amount = Math.min(taxableIncome, bracket.cap) - prevCap;
    if (amount > 0) tax += amount * bracket.rate;
    prevCap = bracket.cap;
  }
  return tax;
}

function generateBestReasons(best, baseline) {
  if (best.id === baseline.id) {
    return [
      "No modeled strategy produced lower total taxes + IRMAA than Pro-Rata for these inputs.",
      "Projected retirement income is already using most low-bracket room, so conversion capacity is limited.",
    ];
  }

  return [
    `Creates ${formatCurrency(best.totalValueCreatedVsBaseline)} in combined net-income and legacy value versus Pro-Rata.`,
    `Estimated to save ${formatCurrency(best.savingsVsBaseline)} in lifetime taxes versus Pro-Rata.`,
  ];
}

function renderResults(model, inputs) {
  resultsSection.classList.remove("hidden");
  topStrategiesEl.innerHTML = "";
  tableBodyEl.innerHTML = "";

  const statusLabel =
    (TAX_CONFIG_BY_STATUS[inputs.filingStatus] || TAX_CONFIG_BY_STATUS.mfj).label;
  let summaryText =
    `Values shown in today\u2019s dollars. Filing status: ${statusLabel}. ` +
    `State assumption: ${GEORGIA_STATE_CODE} (${formatPercent(GEORGIA_STATE_TAX_RATE)}). Current age: ${inputs.currentAge}. ` +
    `Retirement start age: ${inputs.retirementAge}. RMD start age: ${inputs.rmdStartAge}.`;
  if ((inputs.currentAnnualTaxableIncome || 0) > 0) {
    summaryText += ` Pre-retirement taxable income: ${formatCurrency(
      inputs.currentAnnualTaxableIncome
    )}.`;
  }
  if (!model.hasBeatingAlternative) {
    summaryText += " No strategy lowers total taxes below Pro-Rata under current assumptions.";
  }
  summaryTextEl.textContent = summaryText;

  model.top3.forEach((strategy, index) => {
    const card = document.createElement("article");
    card.className = `strategy-card${index === 0 ? " best" : ""}`;

    const badge = index === 0 ? '<span class="badge best">Top Pick</span>' : "";
    const reasons =
      index === 0
        ? `<ul class="reasons">${model.bestReasons.map((r) => `<li>${r}</li>`).join("")}</ul>`
        : "";

    card.innerHTML = `
      ${badge}
      <h4>${escapeHtml(strategy.name)}</h4>
      <p class="subtle">${escapeHtml(strategy.description)}</p>
      <div class="metric-row"><span>Avg. tax rate</span><strong>${formatPercent(strategy.avgTaxRate)}</strong></div>
      <div class="metric-row"><span>Total taxes + IRMAA</span><strong>${formatCurrency(strategy.totalTaxes)}</strong></div>
      <div class="metric-row"><span>Savings vs Pro-Rata</span><strong class="${strategy.savingsVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.savingsVsBaseline)}</strong></div>
      <div class="metric-row"><span>Net income increase</span><strong class="${strategy.netIncomeDeltaVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.netIncomeDeltaVsBaseline)}</strong></div>
      <div class="metric-row"><span>Net legacy increase</span><strong class="${strategy.legacyDeltaVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.legacyDeltaVsBaseline)}</strong></div>
      <div class="metric-row"><span>Total value created</span><strong class="${strategy.totalValueCreatedVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.totalValueCreatedVsBaseline)}</strong></div>
      <div class="metric-row"><span>Total net legacy</span><strong>${formatCurrency(strategy.totalNetLegacy)}</strong></div>
      ${reasons}
    `;

    topStrategiesEl.appendChild(card);
  });

  model.allResults.forEach((strategy) => {
    const row = document.createElement("tr");
    if (model.best && strategy.id === model.best.id) row.classList.add("best-row");

    row.innerHTML = `
      <td data-label="Strategy">${escapeHtml(strategy.name)}</td>
      <td data-label="Avg. Tax Rate">${formatPercent(strategy.avgTaxRate)}</td>
      <td data-label="Total Taxes + IRMAA">${formatCurrency(strategy.totalTaxes)}</td>
      <td data-label="Total Net Income">${formatCurrency(strategy.totalNetIncome)}</td>
      <td data-label="Total Net Legacy">${formatCurrency(strategy.totalNetLegacy)}</td>
      <td data-label="Savings vs Pro-Rata" class="${strategy.savingsVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.savingsVsBaseline)}</td>
      <td data-label="Net Income Increase" class="${strategy.netIncomeDeltaVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.netIncomeDeltaVsBaseline)}</td>
      <td data-label="Net Legacy Increase" class="${strategy.legacyDeltaVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.legacyDeltaVsBaseline)}</td>
      <td data-label="Total Value Created" class="${strategy.totalValueCreatedVsBaseline >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.totalValueCreatedVsBaseline)}</td>
      <td data-label="Total Converted">${formatCurrency(strategy.totalConverted)}</td>
    `;
    tableBodyEl.appendChild(row);
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/[$,%\s,]/g, "")
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableInt(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function pctToDecimal(value) {
  return toNumber(value) / 100;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value) {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(2)}%`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
