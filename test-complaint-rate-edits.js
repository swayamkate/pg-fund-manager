const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const saved = new Map();
const context = { window: {}, localStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) } };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, 'store.js'), 'utf8'), context);
const store = context.window.PGStore;
store.use('historical-issues-test');

assert.equal(store.addRate({ label: 'Shared', amount: 8000, note: 'Original' }).ok, true);
const rateId = store.state().rates[0].id;
assert.equal(store.updateRate(rateId, { label: 'Double sharing', amount: 7600.5, note: 'Corrected' }).ok, true);
assert.equal(store.state().rates.length, 1);
assert.equal(store.state().rates[0].id, rateId);
assert.equal(store.state().rates[0].amount, 7600.5);
const originalRate = JSON.stringify(store.state().rates);
for (const amount of [-1, 0, Infinity, 'abc']) {
  assert.equal(store.updateRate(rateId, { label: 'Invalid', amount }).ok, false);
  assert.equal(JSON.stringify(store.state().rates), originalRate);
}

const result = store.addComplaint({ title: 'Old leak', date: '2020-02-29', roomId: 'room-old', roomNo: '101', priority: 'low' });
assert.equal(result.ok, true);
const issueId = result.complaint.id;
const corrected = { title: 'Kitchen tap', roomId: '', roomNo: '', category: 'Plumbing', priority: 'high', note: 'Historical correction', date: '2019-01-03', resolvedAt: '2019-01-04', status: 'resolved', cost: 450.5, syncExpense: true };
assert.equal(store.updateComplaint(issueId, corrected).ok, true);
assert.equal(store.state().complaints[0].id, issueId);
assert.equal(store.state().complaints[0].date, '2019-01-03');
assert.equal(store.state().complaints[0].resolvedAt, '2019-01-04');
assert.equal(store.state().expenses.length, 1);
const expenseId = store.state().expenses[0].id;
assert.equal(store.state().expenses[0].date, '2019-01-04');
assert.equal(store.state().complaints[0].expenseId, expenseId);
assert.equal(store.updateComplaint(issueId, corrected).ok, true);
assert.equal(store.state().expenses.length, 1);
assert.equal(store.state().expenses[0].id, expenseId);

store.updateExpense(expenseId, { date: '2019-01-08', amount: 460, category: 'Maintenance', note: 'Manual accounting date' });
store.updateComplaint(issueId, { title: 'Kitchen tap corrected', syncExpense: true });
assert.equal(store.state().expenses[0].date, '2019-01-08', 'unchanged issue dates preserve accounting date');
assert.equal(store.state().expenses[0].amount, 460, 'unchanged repair cost preserves direct expense corrections');
store.updateComplaint(issueId, { resolvedAt: '2019-01-09', cost: 499, syncExpense: true });
assert.equal(store.state().expenses[0].date, '2019-01-09');
assert.equal(store.state().expenses[0].amount, 499);
assert.equal(store.state().expenses[0].id, expenseId);

const snapshot = JSON.stringify(store.snapshot());
for (const patch of [{ date: '2019-02-29' }, { resolvedAt: '2020-04-31' }, { date: '0000-01-01' }, { title: ' ' }, { status: 'wrong' }, { cost: Infinity }]) {
  assert.equal(store.updateComplaint(issueId, patch).ok, false);
  assert.equal(JSON.stringify(store.snapshot()), snapshot, 'invalid edits must be atomic');
}
assert.equal(store.updateComplaint(issueId, { date: '2000-02-29', resolvedAt: '2030-12-01' }).ok, true, 'no historical or future date cutoff');
store.use('historical-issues-test');
assert.equal(store.state().complaints[0].expenseId, expenseId);
assert.equal(store.state().complaints[0].resolvedAt, '2030-12-01');

store.replaceAll({ complaints: [{ id: 'legacy-issue', title: 'Legacy repair', date: '2020-01-01', status: 'resolved', cost: 500 }], expenses: [{ id: 'legacy-expense', date: '2020-01-02', category: 'Maintenance', note: 'Repair: Legacy repair', amount: 500 }] });
assert.equal(store.updateComplaint('legacy-issue', { title: 'Corrected legacy repair', syncExpense: true }).ok, true);
assert.equal(store.state().expenses.length, 1);
assert.equal(store.state().complaints[0].expenseId, 'legacy-expense');
assert.equal(store.state().expenses[0].date, '2020-01-02');
store.updateComplaint('legacy-issue', { cost: 0, syncExpense: true });
assert.equal(store.state().expenses.length, 0, 'zero repair cost clears the linked expense when syncing');
assert.equal(store.state().complaints[0].expenseId, '');
console.log('Complaint/rate edits passed: stable IDs, unrestricted real dates, atomic validation, linked expense updates, repeated edits, legacy adoption, local reload.');
