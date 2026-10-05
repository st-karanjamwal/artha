import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate, todayLocal } from '@/lib/dates';
import { formatINR, parseToPaise, paiseToInput } from '@/lib/money';
import {
  formatNav,
  formatUnits,
  fromMicro,
  parseMicro,
  stampDuty,
  unitsFromAmount,
  valuePaise,
} from '@/lib/units';
import { getFolio, getInvestmentAccount } from '@/repositories/mfAccounts';
import { planVariant } from '@/repositories/mfFunds';
import { navOn } from '@/repositories/mfNav';
import {
  TXN_TYPE_LABEL,
  computeTotalAmount,
  createMFTransactionWithBank,
  createSwitch,
  deleteMFTransaction,
  exitLoadWarning,
  listMFTransactions,
  unitsHeld,
  updateMFTransaction,
  type MFTransaction,
  type MFTransactionRow,
  type MFTxnFilter,
} from '@/repositories/mfTransactions';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  FormGrid,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
  cx,
} from '@/components/ui';
import { AccountSelect, Money, MoneyInput, PersonSelect } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { ADD_TYPES, REDUCE_TYPES, type MFTxnType } from './calc/fifo';
import { FolioSelect, InvestmentAccountSelect, MFNav, PlanSelect } from './components';

const FORM_TYPES: MFTxnType[] = [
  'PURCHASE',
  'SIP',
  'REDEMPTION',
  'IDCW_PAYOUT',
  'IDCW_REINVEST',
  'BONUS',
  'TRANSFER_IN',
  'TRANSFER_OUT',
];
const CASH_TYPES: MFTxnType[] = ['PURCHASE', 'SIP', 'REDEMPTION', 'IDCW_PAYOUT'];

const unitsInput = (micro: number | null | undefined) =>
  micro ? fromMicro(micro, 6).replace(/\.?0+$/, '') : '';
const typeTone = (t: MFTxnType) =>
  ADD_TYPES.includes(t) ? 'green' : REDUCE_TYPES.includes(t) ? 'red' : 'slate';

// ---------------------------------------------------------------- transaction form

export function MFTxnForm({
  txn,
  defaults,
  onClose,
}: {
  txn: MFTransaction | null;
  defaults?: { planId?: number; accountId?: number; folioId?: number | null; type?: MFTxnType };
  onClose: () => void;
}) {
  const isBuy = (t: MFTxnType) => t === 'PURCHASE' || t === 'SIP';
  const [v, setV] = useState(() => ({
    type: (txn?.TransactionType ?? defaults?.type ?? 'PURCHASE') as MFTxnType,
    accountId: String(txn?.InvestmentAccountId ?? defaults?.accountId ?? ''),
    planId: String(txn?.MutualFundPlanId ?? defaults?.planId ?? ''),
    folioId: String(txn?.FolioId ?? defaults?.folioId ?? ''),
    date: txn?.TransactionDate ?? todayLocal(),
    // For purchases the user enters the gross cash amount (Amount + stamp duty).
    amount: txn
      ? paiseToInput(
          isBuy(txn.TransactionType) ? txn.Amount + txn.StampDuty + txn.OtherCharges : txn.Amount,
        )
      : '',
    nav: txn?.NAV ? fromMicro(txn.NAV, 4) : '',
    units: unitsInput(txn?.Units),
    stamp: txn ? paiseToInput(txn.StampDuty) : '',
    stt: txn ? paiseToInput(txn.STT) : '',
    exitLoad: txn ? paiseToInput(txn.ExitLoad) : '',
    tds: txn ? paiseToInput(txn.TDS) : '',
    reference: txn?.TransactionReference ?? '',
    remarks: txn?.Remarks ?? '',
    linkBank: false,
    bankAccountId: '',
  }));
  const [touched, setTouched] = useState<{ units: boolean; amount: boolean; stamp: boolean }>({
    units: !!txn,
    amount: !!txn,
    stamp: !!txn,
  });
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const t = v.type;
  const accountId = Number(v.accountId) || 0;
  const planId = Number(v.planId) || 0;
  const folioId = v.folioId ? Number(v.folioId) : null;
  const navMicro = parseMicro(v.nav);
  const unitsMicro = parseMicro(v.units);
  const gross = parseToPaise(v.amount);
  const usesNav = t !== 'IDCW_PAYOUT';
  const amountDriven = isBuy(t) || t === 'IDCW_REINVEST';

  // Default bank: folio's payout bank, else the investment account's linked bank.
  useEffect(() => {
    if (txn || v.bankAccountId) return;
    const bank =
      (folioId && getFolio(folioId)?.BankAccountId) ||
      (accountId && getInvestmentAccount(accountId)?.LinkedBankAccountId);
    if (bank) set({ bankAccountId: String(bank) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, folioId]);

  // NAV of the date, if known (AMFI/history), to prefill.
  useEffect(() => {
    if (txn || v.nav || !planId || !usesNav) return;
    const n = navOn(planId, v.date);
    if (n) set({ nav: fromMicro(n.NAV, 4) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, v.date]);

  // Derived values
  useEffect(() => {
    if (isBuy(t) && !touched.stamp && gross != null) set({ stamp: paiseToInput(stampDuty(gross)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.amount, t]);
  useEffect(() => {
    if (amountDriven && !touched.units && gross != null && navMicro) {
      const stamp = isBuy(t) ? (parseToPaise(v.stamp) ?? 0) : 0;
      set({ units: unitsInput(unitsFromAmount(gross - stamp, navMicro)) });
    }
    if (
      !amountDriven &&
      !touched.amount &&
      unitsMicro &&
      navMicro &&
      t !== 'BONUS' &&
      t !== 'TRANSFER_IN'
    ) {
      set({ amount: paiseToInput(valuePaise(unitsMicro, navMicro)) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.amount, v.nav, v.units, v.stamp, t]);

  const held = useDb(
    () => (accountId && planId ? unitsHeld(accountId, folioId, planId, v.date) : 0),
    [accountId, folioId, planId, v.date, txn?.TransactionId],
  );
  const warning = useMemo(
    () =>
      t === 'REDEMPTION' && accountId && planId && unitsMicro
        ? exitLoadWarning(accountId, folioId, planId, v.date, unitsMicro, gross ?? 0)
        : null,
    [t, accountId, folioId, planId, v.date, unitsMicro, gross],
  );

  const build = () => {
    if (!accountId) throw new Error('Choose the investment account');
    if (!planId) throw new Error('Choose the fund plan');
    const stamp = parseToPaise(v.stamp) ?? 0;
    const amountPaise = gross ?? 0;
    return {
      MutualFundPlanId: planId,
      InvestmentAccountId: accountId,
      FolioId: folioId,
      SIPId: txn?.SIPId ?? null,
      TransactionDate: v.date,
      TransactionType: t,
      NAV: usesNav ? navMicro : null,
      Units: t === 'IDCW_PAYOUT' ? 0 : (unitsMicro ?? 0),
      Amount: t === 'BONUS' ? 0 : isBuy(t) ? amountPaise - stamp : amountPaise,
      StampDuty: isBuy(t) || t === 'IDCW_REINVEST' ? stamp : 0,
      STT: t === 'REDEMPTION' ? (parseToPaise(v.stt) ?? 0) : 0,
      ExitLoad: t === 'REDEMPTION' ? (parseToPaise(v.exitLoad) ?? 0) : 0,
      TDS: t === 'REDEMPTION' || t === 'IDCW_PAYOUT' ? (parseToPaise(v.tds) ?? 0) : 0,
      TransactionReference: v.reference,
      Remarks: v.remarks,
      Source: txn?.Source,
    };
  };

  const preview = (() => {
    try {
      return computeTotalAmount(build());
    } catch {
      return null;
    }
  })();

  const save = () => {
    try {
      const input = build();
      if (txn) updateMFTransaction(txn.TransactionId, input);
      else
        createMFTransactionWithBank(
          input,
          v.linkBank && v.bankAccountId ? Number(v.bankAccountId) : null,
        );
      toast('Saved');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={txn ? 'Edit MF transaction' : 'New MF transaction'}
      footer={<Button onClick={save}>Save</Button>}
    >
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save())}>
        <FormGrid>
          <Field label="Type" required>
            <Select
              value={t}
              disabled={!!txn?.SwitchGroupId}
              onChange={(e) => set({ type: e.target.value as MFTxnType })}
            >
              {(txn?.SwitchGroupId ? [t] : FORM_TYPES).map((x) => (
                <option key={x} value={x}>
                  {TXN_TYPE_LABEL[x]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" required hint="Allotment / NAV date">
            <Input type="date" value={v.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <Field label="Investment account" required>
            <InvestmentAccountSelect
              placeholder="Select…"
              value={v.accountId}
              onChange={(e) => set({ accountId: e.target.value, folioId: '' })}
            />
          </Field>
          <Field label="Fund plan" required>
            <PlanSelect
              placeholder="Select…"
              value={v.planId}
              onChange={(e) => set({ planId: e.target.value })}
            />
          </Field>
          <Field
            label="Folio"
            hint={
              <Link to="/mf/accounts" className="underline">
                Manage folios
              </Link>
            }
          >
            <FolioSelect
              accountId={accountId || undefined}
              value={v.folioId}
              onChange={(e) => set({ folioId: e.target.value })}
            />
          </Field>
          {planId > 0 && accountId > 0 && (
            <div className="self-end pb-2 text-sm text-slate-500">
              Units held on {formatDate(v.date)}:{' '}
              <span className="num font-medium text-slate-800 dark:text-slate-200">
                {formatUnits(held)}
              </span>
            </div>
          )}
        </FormGrid>

        <FormGrid>
          {t !== 'BONUS' && t !== 'TRANSFER_OUT' && (
            <Field
              label={
                isBuy(t)
                  ? 'Amount paid (incl. stamp duty)'
                  : t === 'IDCW_PAYOUT'
                    ? 'Gross IDCW amount'
                    : t === 'TRANSFER_IN'
                      ? 'Original cost'
                      : 'Amount'
              }
              required
            >
              <MoneyInput
                value={v.amount}
                onChange={(e) => {
                  setTouched((x) => ({ ...x, amount: true }));
                  set({ amount: e.target.value });
                }}
              />
            </Field>
          )}
          {usesNav && (
            <Field label="NAV" required>
              <Input
                inputMode="decimal"
                className="num text-right"
                placeholder="125.5000"
                value={v.nav}
                onChange={(e) => set({ nav: e.target.value })}
              />
            </Field>
          )}
          {t !== 'IDCW_PAYOUT' && (
            <Field
              label="Units"
              required
              hint={
                REDUCE_TYPES.includes(t) && held > 0 ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => set({ units: unitsInput(held + (txn ? txn.Units : 0)) })}
                  >
                    Use all {formatUnits(held + (txn ? txn.Units : 0))} units
                  </button>
                ) : amountDriven ? (
                  'Calculated (3 decimals); edit to match your statement.'
                ) : undefined
              }
            >
              <Input
                inputMode="decimal"
                className="num text-right"
                value={v.units}
                onChange={(e) => {
                  setTouched((x) => ({ ...x, units: true }));
                  set({ units: e.target.value });
                }}
              />
            </Field>
          )}
          {(isBuy(t) || t === 'IDCW_REINVEST') && (
            <Field label="Stamp duty" hint={isBuy(t) ? '0.005% of the amount' : undefined}>
              <MoneyInput
                value={v.stamp}
                onChange={(e) => {
                  setTouched((x) => ({ ...x, stamp: true }));
                  set({ stamp: e.target.value });
                }}
              />
            </Field>
          )}
          {t === 'REDEMPTION' && (
            <>
              <Field label="Exit load">
                <MoneyInput
                  value={v.exitLoad}
                  onChange={(e) => set({ exitLoad: e.target.value })}
                />
              </Field>
              <Field label="STT">
                <MoneyInput value={v.stt} onChange={(e) => set({ stt: e.target.value })} />
              </Field>
            </>
          )}
          {(t === 'REDEMPTION' || t === 'IDCW_PAYOUT') && (
            <Field label="TDS">
              <MoneyInput value={v.tds} onChange={(e) => set({ tds: e.target.value })} />
            </Field>
          )}
        </FormGrid>

        {warning && <Alert>{warning}</Alert>}
        {preview != null && CASH_TYPES.includes(t) && (
          <p className="text-sm text-slate-500">
            {REDUCE_TYPES.includes(t) || t === 'IDCW_PAYOUT'
              ? 'Credited to bank'
              : 'Debited from bank'}
            :{' '}
            <span className="num font-medium text-slate-800 dark:text-slate-200">
              {formatINR(preview)}
            </span>
          </p>
        )}

        {!txn && CASH_TYPES.includes(t) && (
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              label="Also record in bank account"
              checked={v.linkBank}
              onChange={(e) => set({ linkBank: e.target.checked })}
            />
            {v.linkBank && (
              <div className="min-w-56 flex-1">
                <AccountSelect
                  placeholder="Bank account…"
                  value={v.bankAccountId}
                  onChange={(e) => set({ bankAccountId: e.target.value })}
                />
              </div>
            )}
          </div>
        )}
        <FormGrid>
          <Field label="Order / reference no.">
            <Input value={v.reference} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
          <Field label="Remarks">
            <Textarea
              rows={1}
              value={v.remarks}
              onChange={(e) => set({ remarks: e.target.value })}
            />
          </Field>
        </FormGrid>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- switch wizard

export function SwitchWizard({
  onClose,
  defaults,
}: {
  onClose: () => void;
  defaults?: { accountId?: number; planId?: number; folioId?: number | null };
}) {
  const [v, setV] = useState({
    accountId: String(defaults?.accountId ?? ''),
    date: todayLocal(),
    fromPlan: String(defaults?.planId ?? ''),
    fromFolio: String(defaults?.folioId ?? ''),
    outUnits: '',
    outNav: '',
    exitLoad: '',
    stt: '',
    toPlan: '',
    toFolio: '',
    inDate: todayLocal(),
    inNav: '',
    inUnits: '',
    stamp: '',
  });
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const acc = Number(v.accountId) || 0;
  const fromPlan = Number(v.fromPlan) || 0;
  const fromFolio = v.fromFolio ? Number(v.fromFolio) : null;
  const held = useDb(
    () => (acc && fromPlan ? unitsHeld(acc, fromFolio, fromPlan, v.date) : 0),
    [acc, fromPlan, fromFolio, v.date],
  );
  const outUnits = parseMicro(v.outUnits);
  const outNav = parseMicro(v.outNav);
  const outAmount = outUnits && outNav ? valuePaise(outUnits, outNav) : 0;
  const inAmount = Math.max(
    0,
    outAmount - (parseToPaise(v.exitLoad) ?? 0) - (parseToPaise(v.stt) ?? 0),
  );
  const stamp = v.stamp ? (parseToPaise(v.stamp) ?? 0) : stampDuty(inAmount);
  const inNav = parseMicro(v.inNav);
  const autoInUnits = inNav && inAmount ? unitsFromAmount(inAmount - stamp, inNav) : null;

  const save = () => {
    try {
      if (!acc || !fromPlan || !v.toPlan) throw new Error('Choose the account and both plans');
      if (!outUnits || !outNav || !inNav) throw new Error('Enter units and NAVs');
      createSwitch({
        InvestmentAccountId: acc,
        TransactionDate: v.date,
        FromPlanId: fromPlan,
        FromFolioId: fromFolio,
        OutUnits: outUnits,
        OutNAV: outNav,
        OutAmount: outAmount,
        ExitLoad: parseToPaise(v.exitLoad) ?? 0,
        STT: parseToPaise(v.stt) ?? 0,
        ToPlanId: Number(v.toPlan),
        ToFolioId: v.toFolio ? Number(v.toFolio) : null,
        InDate: v.inDate,
        InNAV: inNav,
        InUnits: parseMicro(v.inUnits) ?? autoInUnits ?? 0,
        InAmount: inAmount - stamp,
        StampDuty: stamp,
      });
      toast('Switch recorded (both legs)');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Switch between funds"
      footer={<Button onClick={save}>Record switch</Button>}
    >
      <div className="space-y-5">
        <FormGrid>
          <Field label="Investment account" required>
            <InvestmentAccountSelect
              placeholder="Select…"
              value={v.accountId}
              onChange={(e) => set({ accountId: e.target.value, fromFolio: '', toFolio: '' })}
            />
          </Field>
          <Field label="Switch-out date" required>
            <Input
              type="date"
              value={v.date}
              onChange={(e) => set({ date: e.target.value, inDate: e.target.value })}
            />
          </Field>
        </FormGrid>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="mb-3 text-sm font-medium">From</p>
          <FormGrid>
            <Field label="Plan">
              <PlanSelect
                placeholder="Select…"
                value={v.fromPlan}
                onChange={(e) => set({ fromPlan: e.target.value })}
              />
            </Field>
            <Field label="Folio">
              <FolioSelect
                accountId={acc || undefined}
                value={v.fromFolio}
                onChange={(e) => set({ fromFolio: e.target.value })}
              />
            </Field>
            <Field
              label="Units"
              hint={
                <button
                  type="button"
                  className="underline"
                  disabled={!held}
                  onClick={() => set({ outUnits: unitsInput(held) })}
                >
                  Held {formatUnits(held)} · use all
                </button>
              }
            >
              <Input
                inputMode="decimal"
                className="num text-right"
                value={v.outUnits}
                onChange={(e) => set({ outUnits: e.target.value })}
              />
            </Field>
            <Field label="NAV">
              <Input
                inputMode="decimal"
                className="num text-right"
                value={v.outNav}
                onChange={(e) => set({ outNav: e.target.value })}
              />
            </Field>
            <Field label="Exit load">
              <MoneyInput value={v.exitLoad} onChange={(e) => set({ exitLoad: e.target.value })} />
            </Field>
            <Field label="STT">
              <MoneyInput value={v.stt} onChange={(e) => set({ stt: e.target.value })} />
            </Field>
          </FormGrid>
          <p className="mt-2 text-sm text-slate-500">
            Switch-out value: <span className="num font-medium">{formatINR(outAmount)}</span>
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="mb-3 text-sm font-medium">To</p>
          <FormGrid>
            <Field label="Plan">
              <PlanSelect
                placeholder="Select…"
                value={v.toPlan}
                onChange={(e) => set({ toPlan: e.target.value })}
              />
            </Field>
            <Field label="Folio">
              <FolioSelect
                accountId={acc || undefined}
                value={v.toFolio}
                onChange={(e) => set({ toFolio: e.target.value })}
              />
            </Field>
            <Field label="Allotment date">
              <Input
                type="date"
                value={v.inDate}
                onChange={(e) => set({ inDate: e.target.value })}
              />
            </Field>
            <Field label="NAV">
              <Input
                inputMode="decimal"
                className="num text-right"
                value={v.inNav}
                onChange={(e) => set({ inNav: e.target.value })}
              />
            </Field>
            <Field label="Stamp duty" hint={`Default ${formatINR(stampDuty(inAmount))}`}>
              <MoneyInput value={v.stamp} onChange={(e) => set({ stamp: e.target.value })} />
            </Field>
            <Field
              label="Units allotted"
              hint={autoInUnits ? `Calculated ${formatUnits(autoInUnits)}` : undefined}
            >
              <Input
                inputMode="decimal"
                className="num text-right"
                placeholder={autoInUnits ? unitsInput(autoInUnits) : ''}
                value={v.inUnits}
                onChange={(e) => set({ inUnits: e.target.value })}
              />
            </Field>
          </FormGrid>
          <p className="mt-2 text-sm text-slate-500">
            Invested in target:{' '}
            <span className="num font-medium">{formatINR(Math.max(0, inAmount - stamp))}</span>
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- list

export function MFTxnTable({ filter, compact }: { filter: MFTxnFilter; compact?: boolean }) {
  const rows = useDb(() => listMFTransactions(filter), [JSON.stringify(filter)]);
  const [editing, setEditing] = useState<MFTransactionRow | null>(null);
  const [deleting, setDeleting] = useState<MFTransactionRow | null>(null);
  if (!rows.length)
    return (
      <EmptyState title="No transactions">
        Add one, confirm SIP instalments, or import a CAS.
      </EmptyState>
    );
  const sign = (r: MFTransactionRow) =>
    ADD_TYPES.includes(r.TransactionType)
      ? '+'
      : REDUCE_TYPES.includes(r.TransactionType)
        ? '−'
        : '';
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/50">
            <tr>
              <th className="px-3 py-2">Date</th>
              {!compact && <th className="px-3 py-2">Fund</th>}
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">NAV</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-right">Bank flow</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.TransactionId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="whitespace-nowrap px-3 py-2">{formatDate(r.TransactionDate)}</td>
                {!compact && (
                  <td className="max-w-xs px-3 py-2">
                    <Link to={`/mf/plans/${r.MutualFundPlanId}`} className="hover:underline">
                      {r.FundName}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {planVariant(r)} · {r.PersonName}
                      {r.FolioNo && ` · ${r.FolioNo}`}
                    </div>
                  </td>
                )}
                <td className="px-3 py-2">
                  <Badge tone={typeTone(r.TransactionType)}>
                    {TXN_TYPE_LABEL[r.TransactionType]}
                  </Badge>
                  {r.Source !== 'MANUAL' && (
                    <span className="ml-1 text-xs text-slate-400">
                      {r.Source === 'SIP_AUTO' ? 'SIP' : r.Source === 'CAS_IMPORT' ? 'CAS' : 'CSV'}
                    </span>
                  )}
                </td>
                <td className="num px-3 py-2 text-right">
                  {r.Units ? `${sign(r)}${formatUnits(r.Units)}` : '—'}
                </td>
                <td className="num px-3 py-2 text-right">{r.NAV ? formatNav(r.NAV) : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Money paise={r.Amount} />
                </td>
                <td
                  className={cx(
                    'px-3 py-2 text-right',
                    REDUCE_TYPES.includes(r.TransactionType) || r.TransactionType === 'IDCW_PAYOUT'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : '',
                  )}
                >
                  {r.TotalAmount ? (
                    <Money paise={r.TotalAmount} />
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <button
                    className="ml-1 text-slate-400 hover:text-red-600"
                    aria-label="Delete"
                    onClick={() => setDeleting(r)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {rows.map((r) => (
          <li
            key={r.TransactionId}
            className="flex items-start gap-3 p-3"
            onClick={() => setEditing(r)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {compact ? TXN_TYPE_LABEL[r.TransactionType] : r.FundName}
              </p>
              <p className="truncate text-xs text-slate-500">
                {formatDate(r.TransactionDate)} ·{' '}
                {compact
                  ? `NAV ${r.NAV ? formatNav(r.NAV) : '—'}`
                  : TXN_TYPE_LABEL[r.TransactionType]}
              </p>
            </div>
            <div className="text-right">
              <p className="num text-sm font-medium">{formatINR(r.Amount)}</p>
              <p className="num text-xs text-slate-500">
                {r.Units ? `${sign(r)}${formatUnits(r.Units)} u` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {editing && <MFTxnForm txn={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        danger
        title="Delete transaction?"
        message={
          deleting?.SwitchGroupId
            ? 'This is part of a switch; both legs will be deleted.'
            : 'This cannot be undone (except by restoring an earlier vault version). A linked bank entry is kept.'
        }
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          try {
            deleteMFTransaction(deleting!.TransactionId);
          } catch (e) {
            toastError(e);
          }
          setDeleting(null);
        }}
      />
    </>
  );
}

export function MFTransactionsPage() {
  const [params] = useSearchParams();
  const [personId, setPersonId] = useState('');
  const [planId, setPlanId] = useState(params.get('plan') ?? '');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [adding, setAdding] = useState(false);
  const [switching, setSwitching] = useState(false);
  const filter: MFTxnFilter = {
    personId: Number(personId) || undefined,
    planId: Number(planId) || undefined,
    type: (type || undefined) as MFTxnType | undefined,
    from: from || undefined,
    to: to || undefined,
  };
  return (
    <>
      <PageHeader
        title="Mutual funds"
        actions={
          <>
            <Button variant="secondary" onClick={() => setSwitching(true)}>
              Switch
            </Button>
            <Button onClick={() => setAdding(true)}>Add transaction</Button>
          </>
        }
      />
      <MFNav />
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="Person">
            <PersonSelect
              placeholder="Everyone"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            />
          </Field>
          <div className="col-span-2 md:col-span-1">
            <Field label="Fund">
              <PlanSelect
                placeholder="All funds"
                includeInactive
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All</option>
              {Object.entries(TXN_TYPE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>
      <MFTxnTable filter={filter} />
      {adding && (
        <MFTxnForm
          txn={null}
          defaults={{ planId: Number(planId) || undefined }}
          onClose={() => setAdding(false)}
        />
      )}
      {switching && <SwitchWizard onClose={() => setSwitching(false)} />}
    </>
  );
}
