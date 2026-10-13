const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const records = new Map();
const context = vm.createContext({
  window: {},
  localStorage: {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value)
  }
});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, 'store.js'), 'utf8'), context);
const store = context.window.PGStore;
store.use('expense-edits');
store.setProperty('Sunrise PG');
const oldest = store.addExpense({date:'2001-01-02', category:'Custom legacy category', amount:50.25, note:'Original'});
assert.equal(oldest.ok, true);
assert.equal(typeof oldest.id, 'string');
const other = store.addExpense({date:'2025-08-15', category:'Water', amount:800});
assert.equal(other.ok, true);

// A correction can move an old expense into any real calendar month and
// updates the original record, so totals, order and cloud IDs stay coherent.
assert.equal(store.updateExpense(oldest.id, {date:'2024-02-29', category:'Electricity', amount:'1200.50', note:'Corrected bill'}).ok, true);
assert.equal(store.state().expenses.length, 2);
let corrected = store.state().expenses.find((entry) => entry.id === oldest.id);
assert.equal(corrected.amount, 1200.5);
assert.equal(corrected.date, '2024-02-29');
assert.equal(corrected.note, 'Corrected bill');
assert.equal(store.state().expenses[0].id, other.id);
assert.equal(store.state().expenses.filter((entry) => entry.date.startsWith('2024-02')).reduce((sum, entry) => sum + entry.amount, 0), 1200.5);
assert.equal(store.state().expenses.filter((entry) => entry.date.startsWith('2001-01')).length, 0);

// Rejected changes must leave both the expense and persisted data unchanged.
for (const patch of [
  {date:'2025-02-29', amount:1}, {date:'2026-04-31', amount:1},
  {date:'2026-13-01', amount:1}, {date:'2026-1-01', amount:1},
  {date:'0000-01-01', amount:1}, {date:'', amount:1},
  {date:'2025-01-01', amount:Infinity}, {date:'2025-01-01', amount:'not a number'},
  {date:'2025-01-01', amount:0}, {date:'2025-01-01', amount:-10}
]) {
  const before = JSON.stringify(store.state());
  const persisted = records.get('pgData:expense-edits');
  assert.equal(store.updateExpense(oldest.id, patch).ok, false, JSON.stringify(patch));
  assert.equal(JSON.stringify(store.state()), before);
  assert.equal(records.get('pgData:expense-edits'), persisted);
}
assert.equal(store.updateExpense('missing', {date:'2025-01-01', amount:1}).ok, false);
for (const data of [
  {date:'2025-02-29', amount:1}, {date:'2025-01-01', amount:Infinity}
]) {
  const before = JSON.stringify(store.state());
  assert.equal(store.addExpense(data).ok, false);
  assert.equal(JSON.stringify(store.state()), before);
}

store.use('another-account');
assert.equal(store.state().expenses.length, 0);
store.use('expense-edits');
corrected = store.state().expenses.find((entry) => entry.id === oldest.id);
assert.equal(corrected.amount, 1200.5);
assert.equal(corrected.date, '2024-02-29');
assert.equal(corrected.note, 'Corrected bill');
console.log('Expense history verified: old dates, leap day, stable ID, month totals/order, reload/account isolation and atomic rejection of invalid edits.');
