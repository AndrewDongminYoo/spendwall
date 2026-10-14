import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApprovalKeys,
  prepareApproval,
} from '../apps/firewall/src/approvals/binding.ts';

const version = 'a'.repeat(64),
  adapter = 'b'.repeat(64);
const input = () => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  context: {
    tool: 'create_refund',
    args: { capture_id: 'SYNTHETICCAPTURE1' },
    amount: { value: '60', currency: 'USD' },
    agent: { id: 'support' },
    merchant: { id: 'merchantA' },
    customer: { id: 'customerA' },
    agg: {},
  },
  resolvedCtx: {},
});

test('approval freezes an explicit normalized refund amount before reservation', () => {
  const prepared = prepareApproval(version, input(), 'merchantA', adapter);
  assert.deepEqual(prepared.input.context.args.amount, {
    value: '60.00',
    currency_code: 'USD',
  });
  const conflict = input();
  conflict.context.args.amount = { value: '70', currency_code: 'USD' };
  assert.throws(() => prepareApproval(version, conflict, 'merchantA', adapter));
  assert.throws(() =>
    prepareApproval(version, input(), 'otherMerchant', adapter),
  );
});

test('approval binding changes for every execution authority field', () => {
  const keys = new ApprovalKeys('7'.repeat(64));
  const fingerprint = (p, v = version, account = adapter) =>
    keys.reference(
      'binding',
      prepareApproval(v, p, 'merchantA', account).binding,
    );
  const original = fingerprint(input());
  for (const change of [
    (p) => {
      p.context.args.capture_id = 'DIFFERENTCAPTURE1';
    },
    (p) => {
      p.context.amount.value = '61';
    },
    (p) => {
      p.context.agent.id = 'other';
    },
    (p) => {
      p.context.customer.id = 'other';
    },
    (p) => {
      p.context.args.note_to_payer = 'changed';
    },
  ]) {
    const p = input();
    change(p);
    assert.notEqual(fingerprint(p), original);
  }
  assert.notEqual(fingerprint(input(), 'c'.repeat(64)), original);
  assert.notEqual(fingerprint(input(), version, 'd'.repeat(64)), original);
});

test('private approval snapshots authenticate the key, row binding and ciphertext', () => {
  const keys = new ApprovalKeys('7'.repeat(64));
  const sealed = keys.seal(
    { capture: 'private synthetic value' },
    'approval-1',
  );
  assert.doesNotMatch(sealed, /private synthetic/);
  assert.deepEqual(keys.open(sealed, 'approval-1'), {
    capture: 'private synthetic value',
  });
  assert.throws(() => keys.open(sealed, 'other-approval'));
  assert.throws(() =>
    new ApprovalKeys('8'.repeat(64)).open(sealed, 'approval-1'),
  );
  assert.throws(() => keys.open(sealed.slice(0, -2), 'approval-1'));
});
