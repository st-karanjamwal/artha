import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate, todayLocal } from '@/lib/dates';
import { formatINR, parseToPaise, paiseToInput } from '@/lib/money';
import {
  formatBps,
  formatUnits,
  fromMicro,
  parseBps,
  parseMicro,
  stampDuty,
  unitsFromAmount,
} from '@/lib/units';
import { planVariant } from '@/repositories/mfFunds';
import { navOn } from '@/repositories/mfNav';
import {
  FREQUENCY_LABEL,
  confirmSipInstalment,
  createSip,
  currentSipAmount,
  deleteSip,
  listSips,
  nextSipDate,
  pauseSip,
  pauseWindows,
  pendingSipConfirmations,
  resumeSip,
  sipHistory,
  sipTotals,
  stopSip,
  updateSip,
  type PendingInstalment,
  type SIPRow,
} from '@/repositories/sips';
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
} from '@/components/ui';
import { AccountSelect, Money, MoneyInput } from '@/components/inputs';
import { toast, toastError } from '@/components/toast';
import { addDaysIso, instalments, type SipFrequency } from './calc/sipSchedule';
import { FolioSelect, InvestmentAccountSelect, MFNav, PlanSelect, Stat } from './components';

const STATUS_TONE = {
  ACTIVE: 'green',
  PAUSED: 'amber',
  STOPPED: 'slate',
  COMPLETED: 'slate',
} as const;

// ---------------------------------------------------------------- confirm instalment

export function ConfirmSipModal({ p, onClose }: { p: PendingInstalment; onClose: () => void }) {
  const [date, setDate] = useState(p.date);
  const [amount, setAmount] = useState(paiseToInput(p.amount));
  const [nav, setNav] = useState(p.nav ? fromMicro(p.nav, 4) : '');
  const [units, setUnits] = useState('');
  const [stamp, setStamp] = useState(paiseToInput(stampDuty(p.amount)));
  const [folioId, setFolioId] = useState(p.sip.FolioId ? String(p.sip.FolioId) : '');
  const [bank, setBank] = useState(!!p.sip.DebitBankAccountId);
  useEffect(() => {
    const n = navOn(p.sip.MutualFundPlanId, date);
    if (n) setNav(fromMicro(n.NAV, 4));
  }, [date, p.sip.MutualFundPlanId]);
  const gross = parseToPaise(amount) ?? 0;
  const stampP = parseToPaise(stamp) ?? 0;
  const navM = parseMicro(nav);
  const autoUnits = navM && gross > stampP ? unitsFromAmount(gross - stampP, navM) : null;
  const save = () => {
    try {
      if (!navM) throw new Error('Enter the NAV of the allotment date');
      confirmSipInstalment({
        sipId: p.sip.SIPId,
        date,
        amount: gross,
        nav: navM,
        units: parseMicro(units) ?? undefined,
        stampDuty: stampP,
        folioId: folioId ? Number(folioId) : null,
        createBankDebit: bank,
      });
      toast('Instalment recorded');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Confirm SIP · ${p.sip.FundName}`}
      footer={<Button onClick={save}>Confirm</Button>}
    >
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save())}>
        <p className="text-sm text-slate-500">
          Scheduled {formatDate(p.date)} · {p.sip.PersonName} · {planVariant(p.sip)}
        </p>
        <FormGrid>
          <Field label="Allotment date" hint="Change if it was a holiday">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Amount debited">
            <MoneyInput
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setStamp(paiseToInput(stampDuty(parseToPaise(e.target.value) ?? 0)));
              }}
            />
          </Field>
          <Field
            label="NAV"
            hint={p.nav ? undefined : 'Not in history yet; enter from the statement or refresh NAV'}
          >
            <Input
              inputMode="decimal"
              className="num text-right"
              autoFocus={!p.nav}
              value={nav}
              onChange={(e) => setNav(e.target.value)}
            />
          </Field>
          <Field label="Stamp duty">
            <MoneyInput value={stamp} onChange={(e) => setStamp(e.target.value)} />
          </Field>
          <Field
            label="Units allotted"
            hint={
              autoUnits
                ? `Calculated ${formatUnits(autoUnits)}; edit to match the statement`
                : undefined
            }
          >
            <Input
              inputMode="decimal"
              className="num text-right"
              placeholder={autoUnits ? formatUnits(autoUnits).replace(/,/g, '') : ''}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
            />
          </Field>
          <Field label="Folio">
            <FolioSelect
              accountId={p.sip.InvestmentAccountId}
              value={folioId}
              onChange={(e) => setFolioId(e.target.value)}
            />
          </Field>
        </FormGrid>
        {p.sip.DebitBankAccountId ? (
          <Checkbox
            label="Also record the debit in the SIP's bank account"
            checked={bank}
            onChange={(e) => setBank(e.target.checked)}
          />
        ) : (
          <p className="text-xs text-slate-500">
            Set a debit bank on the SIP to record the bank debit automatically.
          </p>
        )}
      </form>
    </Modal>
  );
}

export function PendingSips({ limit }: { limit?: number }) {
  const pending = useDb(() => pendingSipConfirmations());
  const [confirming, setConfirming] = useState<PendingInstalment | null>(null);
  if (!pending.length) return null;
  const shown = limit ? pending.slice(0, limit) : pending;
  return (
    <Card
      title={`Pending SIP confirmations (${pending.length})`}
      className="border-amber-300 dark:border-amber-800"
    >
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {shown.map((p) => (
          <li
            key={`${p.sip.SIPId}-${p.date}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{p.sip.FundName}</p>
              <p className="text-xs text-slate-500">
                {formatDate(p.date)} · {p.sip.PersonName} · {formatINR(p.amount)}
                {p.nav ? '' : ' · NAV needed'}
              </p>
            </div>
            <Button size="sm" onClick={() => setConfirming(p)}>
              Confirm
            </Button>
          </li>
        ))}
      </ul>
      {limit && pending.length > limit && (
        <Link
          to="/mf/sips"
          className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-500"
        >
          See all {pending.length} →
        </Link>
      )}
      {confirming && <ConfirmSipModal p={confirming} onClose={() => setConfirming(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------- SIP form

function SipForm({ sip, onClose }: { sip: SIPRow | null; onClose: () => void }) {
  const [v, setV] = useState({
    planId: String(sip?.MutualFundPlanId ?? ''),
    accountId: String(sip?.InvestmentAccountId ?? ''),
    folioId: String(sip?.FolioId ?? ''),
    amount: sip ? paiseToInput(sip.SIPAmount) : '',
    frequency: (sip?.Frequency ?? 'MONTHLY') as SipFrequency,
    sipDate: String(sip?.SIPDate ?? ''),
    start: sip?.StartDate ?? todayLocal(),
    end: sip?.EndDate ?? '',
    stepUp: sip?.StepUpPercentBps ? formatBps(sip.StepUpPercentBps) : '',
    stepUpFreq: sip?.StepUpFrequency ?? 'YEARLY',
    mandate: sip?.MandateReference ?? '',
    bank: String(sip?.DebitBankAccountId ?? ''),
    autoDebit: sip ? !!sip.AutoDebit : true,
    notes: sip?.Notes ?? '',
  });
  const set = (p: Partial<typeof v>) => setV((o) => ({ ...o, ...p }));
  const monthlyPlus = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'].includes(v.frequency);
  const save = () => {
    try {
      const amount = parseToPaise(v.amount);
      if (!amount) throw new Error('Enter the SIP amount');
      if (!v.planId || !v.accountId) throw new Error('Choose the fund and the investment account');
      const input = {
        MutualFundPlanId: Number(v.planId),
        InvestmentAccountId: Number(v.accountId),
        FolioId: v.folioId ? Number(v.folioId) : null,
        SIPAmount: amount,
        Frequency: v.frequency,
        SIPDate: monthlyPlus ? Number(v.sipDate) || Number(v.start.slice(8, 10)) : null,
        StartDate: v.start,
        EndDate: v.end || null,
        StepUpPercentBps: parseBps(v.stepUp),
        StepUpFrequency: v.stepUp ? (v.stepUpFreq as 'YEARLY' | 'HALF_YEARLY') : null,
        AutoDebit: v.autoDebit,
        MandateReference: v.mandate,
        DebitBankAccountId: v.bank ? Number(v.bank) : null,
        Notes: v.notes,
      };
      if (sip) updateSip(sip.SIPId, input);
      else createSip(input);
      toast('SIP saved');
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
      title={sip ? 'Edit SIP' : 'New SIP'}
      footer={<Button onClick={save}>Save</Button>}
    >
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save())}>
        <FormGrid>
          <Field label="Fund plan" required>
            <PlanSelect
              placeholder="Select…"
              value={v.planId}
              onChange={(e) => set({ planId: e.target.value })}
            />
          </Field>
          <Field label="Investment account" required>
            <InvestmentAccountSelect
              placeholder="Select…"
              value={v.accountId}
              onChange={(e) => set({ accountId: e.target.value, folioId: '' })}
            />
          </Field>
          <Field label="Folio" hint="Known after the first allotment">
            <FolioSelect
              accountId={Number(v.accountId) || undefined}
              value={v.folioId}
              onChange={(e) => set({ folioId: e.target.value })}
            />
          </Field>
          <Field label="Amount per instalment" required>
            <MoneyInput value={v.amount} onChange={(e) => set({ amount: e.target.value })} />
          </Field>
          <Field label="Frequency">
            <Select
              value={v.frequency}
              onChange={(e) => set({ frequency: e.target.value as SipFrequency })}
            >
              {Object.entries(FREQUENCY_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {monthlyPlus && (
            <Field label="SIP day of month" hint="29–31 fall back to the month's last day">
              <Input
                type="number"
                min={1}
                max={31}
                placeholder={v.start.slice(8, 10)}
                value={v.sipDate}
                onChange={(e) => set({ sipDate: e.target.value })}
              />
            </Field>
          )}
          <Field label="Start date" required>
            <Input type="date" value={v.start} onChange={(e) => set({ start: e.target.value })} />
          </Field>
          <Field label="End date" hint="Blank = perpetual">
            <Input type="date" value={v.end} onChange={(e) => set({ end: e.target.value })} />
          </Field>
          <Field label="Step-up %">
            <Input
              inputMode="decimal"
              placeholder="10"
              value={v.stepUp}
              onChange={(e) => set({ stepUp: e.target.value })}
            />
          </Field>
          {v.stepUp && (
            <Field label="Step-up every">
              <Select
                value={v.stepUpFreq}
                onChange={(e) => set({ stepUpFreq: e.target.value as 'YEARLY' | 'HALF_YEARLY' })}
              >
                <option value="YEARLY">12 months</option>
                <option value="HALF_YEARLY">6 months</option>
              </Select>
            </Field>
          )}
          <Field label="Debit bank account">
            <AccountSelect
              placeholder="—"
              value={v.bank}
              onChange={(e) => set({ bank: e.target.value })}
            />
          </Field>
          <Field label="Mandate reference (NACH / UPI AutoPay)">
            <Input value={v.mandate} onChange={(e) => set({ mandate: e.target.value })} />
          </Field>
        </FormGrid>
        <Checkbox
          label="Auto-debit"
          checked={v.autoDebit}
          onChange={(e) => set({ autoDebit: e.target.checked })}
        />
        <Field label="Notes">
          <Textarea rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </form>
    </Modal>
  );
}

function PauseModal({ sip, onClose }: { sip: SIPRow; onClose: () => void }) {
  const [until, setUntil] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Pause ${sip.FundName}`}
      footer={
        <Button
          onClick={() => {
            pauseSip(sip.SIPId, until || null);
            toast('SIP paused');
            onClose();
          }}
        >
          Pause
        </Button>
      }
    >
      <Field label="Paused until (inclusive)" hint="Leave blank to pause until you resume it.">
        <Input
          type="date"
          min={todayLocal()}
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

function HistoryModal({ sip, onClose }: { sip: SIPRow; onClose: () => void }) {
  const rows = useDb(() => sipHistory(sip.SIPId), [sip.SIPId]);
  return (
    <Modal open onClose={onClose} title={`History · ${sip.FundName}`}>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {rows.map((h) => (
          <li key={h.SIPHistoryId} className="py-2">
            <span className="font-medium">{h.Action.replace('_', ' ').toLowerCase()}</span>{' '}
            <span className="text-slate-500">{formatDate(h.ChangedOn.slice(0, 10))}</span>
            {h.Details && <div className="font-mono text-xs text-slate-500">{h.Details}</div>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export function SipsPage() {
  const sips = useDb(() => listSips());
  const totals = useDb(() => sipTotals());
  const today = todayLocal();
  const [editing, setEditing] = useState<SIPRow | null | 'new'>(null);
  const [pausing, setPausing] = useState<SIPRow | null>(null);
  const [history, setHistory] = useState<SIPRow | null>(null);
  const [stopping, setStopping] = useState<SIPRow | null>(null);

  const upcoming = useMemo(
    () =>
      sips
        .filter((s) => s.Status === 'ACTIVE' || s.Status === 'PAUSED')
        .flatMap((s) =>
          instalments(s, today, addDaysIso(today, 45), pauseWindows(s.SIPId)).map((i) => ({
            ...i,
            s,
          })),
        )
        .sort((a, b) => a.date.localeCompare(b.date)),
    [sips, today],
  );
  const byDate = useMemo(() => {
    const m = new Map<string, typeof upcoming>();
    for (const u of upcoming) m.set(u.date, [...(m.get(u.date) ?? []), u]);
    return [...m.entries()];
  }, [upcoming]);

  return (
    <>
      <PageHeader
        title="Mutual funds"
        actions={<Button onClick={() => setEditing('new')}>New SIP</Button>}
      />
      <MFNav />
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Monthly SIP"
          value={<Money paise={totals.monthly} />}
          sub={`${totals.count} active SIP${totals.count === 1 ? '' : 's'}`}
        />
        <Stat label="Annual SIP" value={<Money paise={totals.annual} />} />
        {totals.byPerson.slice(0, 2).map((p) => (
          <Stat
            key={p.PersonId}
            label={p.PersonName}
            value={<Money paise={p.monthly} />}
            sub={`per month · ${formatINR(p.annual, { decimals: false })} a year`}
          />
        ))}
      </div>
      <div className="mb-4">
        <PendingSips />
      </div>
      {sips.length === 0 ? (
        <EmptyState
          title="No SIPs yet"
          action={<Button onClick={() => setEditing('new')}>New SIP</Button>}
        >
          Add your SIPs to track instalments, upcoming dates and monthly totals.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {sips.map((s) => {
              const next = nextSipDate(s, today);
              return (
                <Card key={s.SIPId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/mf/plans/${s.MutualFundPlanId}`}
                        className="font-semibold hover:underline"
                      >
                        {s.FundName}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {planVariant(s)} · {s.PersonName} · {s.AccountName}
                        {s.FolioNumber && ` · ${s.FolioNumber}`}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="num font-semibold">{formatINR(currentSipAmount(s, today))}</p>
                      <p className="text-xs text-slate-500">
                        {FREQUENCY_LABEL[s.Frequency]}
                        {s.SIPDate && ` · day ${s.SIPDate}`}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={STATUS_TONE[s.Status]}>{s.Status.toLowerCase()}</Badge>
                    {s.PausedUntil && <Badge tone="amber">until {formatDate(s.PausedUntil)}</Badge>}
                    {next && <Badge tone="brand">next {formatDate(next.date)}</Badge>}
                    {s.StepUpPercentBps && (
                      <Badge>step-up {formatBps(s.StepUpPercentBps, 0)}%</Badge>
                    )}
                    <span className="text-slate-500">
                      {s.InstalmentCount} instalments · <Money paise={s.InvestedTotal} /> invested ·
                      since {formatDate(s.StartDate)}
                      {s.EndDate && ` · ends ${formatDate(s.EndDate)}`}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    {s.Status === 'ACTIVE' && (
                      <Button size="sm" variant="ghost" onClick={() => setPausing(s)}>
                        Pause
                      </Button>
                    )}
                    {s.Status === 'PAUSED' && (
                      <Button size="sm" variant="ghost" onClick={() => resumeSip(s.SIPId)}>
                        Resume
                      </Button>
                    )}
                    {(s.Status === 'ACTIVE' || s.Status === 'PAUSED') && (
                      <Button size="sm" variant="ghost" onClick={() => setStopping(s)}>
                        Stop
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setHistory(s)}>
                      History
                    </Button>
                    {s.InstalmentCount === 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          try {
                            deleteSip(s.SIPId);
                          } catch (e) {
                            toastError(e);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
          <Card title="Upcoming (45 days)">
            {byDate.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing scheduled.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {byDate.map(([d, items]) => (
                  <li key={d}>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {formatDate(d)}
                    </p>
                    {items.map((u) => (
                      <div key={u.s.SIPId} className="flex justify-between gap-2">
                        <span className="truncate">{u.s.FundName}</span>
                        <Money paise={u.amount} />
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {totals.byPerson.length > 2 && (
              <Alert tone="brand">
                {totals.byPerson
                  .map((p) => `${p.PersonName}: ${formatINR(p.monthly, { decimals: false })}/month`)
                  .join(' · ')}
              </Alert>
            )}
          </Card>
        </div>
      )}
      {editing && (
        <SipForm sip={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {pausing && <PauseModal sip={pausing} onClose={() => setPausing(null)} />}
      {history && <HistoryModal sip={history} onClose={() => setHistory(null)} />}
      <ConfirmDialog
        open={!!stopping}
        title="Stop this SIP?"
        message="No instalments will be expected after today. Past instalments and history are kept."
        confirmLabel="Stop SIP"
        onCancel={() => setStopping(null)}
        onConfirm={() => {
          stopSip(stopping!.SIPId);
          setStopping(null);
        }}
      />
    </>
  );
}
