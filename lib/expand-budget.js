const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.EXPAND_USAGE_STORE_PATH
  || path.join(__dirname, '..', 'data', 'expand-usage.json');

const BUDGET_USD = Number(process.env.GEMINI_MONTHLY_BUDGET_USD || 5);
const COST_PER_IMAGE_USD = Number(process.env.GEMINI_COST_PER_IMAGE_USD || 0.04);

function currentMonthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function loadState() {
  const month = currentMonthKey();
  try {
    const state = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (state.month === month && typeof state.spentUsd === 'number') return state;
  } catch (_) {}
  return { month, spentUsd: 0, count: 0 };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

// Aktuellen Budget-Status ermitteln, ohne ihn zu verändern.
function checkBudget() {
  const state = loadState();
  const remainingUsd = Math.max(0, Math.round((BUDGET_USD - state.spentUsd) * 10000) / 10000);
  return {
    allowed: remainingUsd >= COST_PER_IMAGE_USD,
    month: state.month,
    spentUsd: state.spentUsd,
    budgetUsd: BUDGET_USD,
    remainingUsd,
    costPerImageUsd: COST_PER_IMAGE_USD,
    generationsLeft: Math.floor(remainingUsd / COST_PER_IMAGE_USD),
    generationsUsed: state.count,
  };
}

// Nur nach einer TATSÄCHLICH erfolgreichen (kostenpflichtigen) Generierung aufrufen,
// nie vorab und nie für die kostenlose Mock-Generierung.
function recordGeneration() {
  const state = loadState();
  state.spentUsd = Math.round((state.spentUsd + COST_PER_IMAGE_USD) * 10000) / 10000;
  state.count += 1;
  saveState(state);
  return checkBudget();
}

module.exports = { checkBudget, recordGeneration };
