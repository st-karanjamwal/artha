import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDb } from '@/app/session';
import { formatDate } from '@/lib/dates';
import { formatBps, formatNav, parseBps } from '@/lib/units';
import {
  OPTION_LABEL,
  PLAN_LABEL,
  addPlanFromAmfi,
  createFund,
  createPlan,
  deletePlan,
  findPlan,
  getFund,
  listPlans,
  planVariant,
  updateFund,
  updatePlan,
  type MutualFund,
  type PlanListItem,
} from '@/repositories/mfFunds';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  FormGrid,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { toast, toastError } from '@/components/toast';
import { searchSchemes, type AmfiScheme, type OptionType, type PlanType } from './amfi';
import { MFNav } from './components';
import { loadAmfiList } from './navService';

const CATEGORIES = ['Equity', 'Debt', 'Hybrid', 'Solution Oriented', 'Other'];
const RISK = ['Low', 'Low to Moderate', 'Moderate', 'Moderately High', 'High', 'Very High'];

function AmfiSearch({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<AmfiScheme[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());
  useEffect(() => {
    loadAmfiList()
      .then(setList)
      .catch((e) => setErr((e as Error).message));
  }, []);
  const results = useMemo(() => (list ? searchSchemes(list, q) : []), [list, q]);
  return (
    <Modal open wide onClose={onClose} title="Add funds from AMFI">
      {err ? (
        <Alert tone="red">
          {err}. You can still <strong>add a fund manually</strong>.
        </Alert>
      ) : !list ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading the AMFI scheme list…
        </p>
      ) : (
        <>
          <Input
            autoFocus
            placeholder="Search by fund name, AMC, scheme code or ISIN…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <p className="mt-2 text-xs text-slate-500">
            {list.length.toLocaleString('en-IN')} schemes · public AMFI data
          </p>
          <ul className="mt-3 max-h-[60dvh] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {results.map((s) => {
              const exists =
                added.has(s.schemeCode) || !!findPlan({ isin: s.isin, schemeCode: s.schemeCode });
              return (
                <li
                  key={s.schemeCode}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{s.schemeName}</p>
                    <p className="text-xs text-slate-500">
                      {s.amc} · {s.category}
                      {s.subCategory && ` / ${s.subCategory}`} · {PLAN_LABEL[s.planType]} ·{' '}
                      {OPTION_LABEL[s.optionType]} · code {s.schemeCode}
                      {s.isin && ` · ${s.isin}`}
                      {s.nav && ` · NAV ${formatNav(s.nav)} (${formatDate(s.navDate)})`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={exists ? 'ghost' : 'secondary'}
                    disabled={exists}
                    onClick={() => {
                      try {
                        addPlanFromAmfi(s);
                        setAdded((a) => new Set(a).add(s.schemeCode));
                        toast(`Added ${s.fundName}`);
                      } catch (e) {
                        toastError(e);
                      }
                    }}
                  >
                    {exists ? 'Added' : 'Add'}
                  </Button>
                </li>
              );
            })}
            {q && !results.length && <li className="py-4 text-sm text-slate-500">No matches.</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

interface PlanForm {
  PlanType: PlanType;
  OptionType: OptionType;
  SchemeCode: string;
  ISIN: string;
  ISINReinvest: string;
  ExpenseRatio: string;
  ExitLoad: string;
  ExitLoadDays: string;
  ExitLoadPercent: string;
  Status: 'ACTIVE' | 'MERGED' | 'CLOSED';
}

const emptyPlan: PlanForm = {
  PlanType: 'DIRECT',
  OptionType: 'GROWTH',
  SchemeCode: '',
  ISIN: '',
  ISINReinvest: '',
  ExpenseRatio: '',
  ExitLoad: '',
  ExitLoadDays: '',
  ExitLoadPercent: '',
  Status: 'ACTIVE',
};

function planToForm(p: PlanListItem): PlanForm {
  return {
    PlanType: p.PlanType,
    OptionType: p.OptionType,
    SchemeCode: p.SchemeCode ?? '',
    ISIN: p.ISIN ?? '',
    ISINReinvest: p.ISINReinvest ?? '',
    ExpenseRatio: formatBps(p.ExpenseRatioBps),
    ExitLoad: p.ExitLoad ?? '',
    ExitLoadDays: p.ExitLoadDays?.toString() ?? '',
    ExitLoadPercent: formatBps(p.ExitLoadPercentBps),
    Status: p.Status,
  };
}

function formToPlan(f: PlanForm) {
  if (f.ISIN && !/^INF[A-Z0-9]{9}$/i.test(f.ISIN)) throw new Error('ISIN looks like INF179K01UT0');
  if (f.SchemeCode && !/^\d{3,8}$/.test(f.SchemeCode))
    throw new Error('AMFI scheme code is digits only');
  return {
    PlanType: f.PlanType,
    OptionType: f.OptionType,
    SchemeCode: f.SchemeCode || null,
    ISIN: f.ISIN || null,
    ISINReinvest: f.ISINReinvest || null,
    ExpenseRatioBps: parseBps(f.ExpenseRatio),
    ExitLoad: f.ExitLoad || null,
    ExitLoadDays: f.ExitLoadDays ? Number(f.ExitLoadDays) : null,
    ExitLoadPercentBps: parseBps(f.ExitLoadPercent),
    Status: f.Status,
  };
}

function PlanFields({ v, set }: { v: PlanForm; set: (p: Partial<PlanForm>) => void }) {
  return (
    <FormGrid>
      <Field label="Plan">
        <Select value={v.PlanType} onChange={(e) => set({ PlanType: e.target.value as PlanType })}>
          <option value="DIRECT">Direct</option>
          <option value="REGULAR">Regular</option>
        </Select>
      </Field>
      <Field label="Option">
        <Select
          value={v.OptionType}
          onChange={(e) => set({ OptionType: e.target.value as OptionType })}
        >
          {Object.entries(OPTION_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="AMFI scheme code" hint="Used for daily NAV refresh.">
        <Input
          inputMode="numeric"
          value={v.SchemeCode}
          onChange={(e) => set({ SchemeCode: e.target.value.trim() })}
        />
      </Field>
      <Field label="ISIN">
        <Input
          className="uppercase"
          value={v.ISIN}
          onChange={(e) => set({ ISIN: e.target.value.trim().toUpperCase() })}
        />
      </Field>
      <Field label="ISIN (IDCW reinvest)">
        <Input
          className="uppercase"
          value={v.ISINReinvest}
          onChange={(e) => set({ ISINReinvest: e.target.value.trim().toUpperCase() })}
        />
      </Field>
      <Field label="Expense ratio (%)">
        <Input
          inputMode="decimal"
          placeholder="0.65"
          value={v.ExpenseRatio}
          onChange={(e) => set({ ExpenseRatio: e.target.value })}
        />
      </Field>
      <Field label="Exit load (text)">
        <Input
          placeholder="1% if redeemed within 365 days"
          value={v.ExitLoad}
          onChange={(e) => set({ ExitLoad: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Exit load days">
          <Input
            inputMode="numeric"
            value={v.ExitLoadDays}
            onChange={(e) => set({ ExitLoadDays: e.target.value })}
          />
        </Field>
        <Field label="Exit load %">
          <Input
            inputMode="decimal"
            value={v.ExitLoadPercent}
            onChange={(e) => set({ ExitLoadPercent: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Status">
        <Select
          value={v.Status}
          onChange={(e) => set({ Status: e.target.value as PlanForm['Status'] })}
        >
          <option value="ACTIVE">Active</option>
          <option value="MERGED">Merged</option>
          <option value="CLOSED">Closed</option>
        </Select>
      </Field>
    </FormGrid>
  );
}

type FundForm = Omit<MutualFund, 'MutualFundId'>;
const emptyFund: FundForm = {
  AMCName: '',
  FundName: '',
  Category: 'Equity',
  SubCategory: '',
  Benchmark: '',
  FundType: 'Open Ended',
  RiskLevel: '',
  InceptionDate: '',
  TaxClass: null,
  Status: 'ACTIVE',
  Notes: '',
};

function FundFields({ v, set }: { v: FundForm; set: (p: Partial<FundForm>) => void }) {
  return (
    <FormGrid>
      <Field label="AMC" required>
        <Input
          placeholder="HDFC Mutual Fund"
          value={v.AMCName}
          onChange={(e) => set({ AMCName: e.target.value })}
        />
      </Field>
      <Field label="Fund name" required>
        <Input
          placeholder="HDFC Flexi Cap Fund"
          value={v.FundName}
          onChange={(e) => set({ FundName: e.target.value })}
        />
      </Field>
      <Field label="Category">
        <Select value={v.Category ?? ''} onChange={(e) => set({ Category: e.target.value })}>
          <option value="">—</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label="Sub-category">
        <Input
          placeholder="Flexi Cap"
          value={v.SubCategory ?? ''}
          onChange={(e) => set({ SubCategory: e.target.value })}
        />
      </Field>
      <Field label="Risk (riskometer)">
        <Select value={v.RiskLevel ?? ''} onChange={(e) => set({ RiskLevel: e.target.value })}>
          <option value="">—</option>
          {RISK.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </Field>
      <Field label="Benchmark">
        <Input value={v.Benchmark ?? ''} onChange={(e) => set({ Benchmark: e.target.value })} />
      </Field>
      <Field label="Fund type">
        <Select value={v.FundType ?? ''} onChange={(e) => set({ FundType: e.target.value })}>
          <option>Open Ended</option>
          <option>Close Ended</option>
          <option>Interval</option>
        </Select>
      </Field>
      <Field label="Inception date">
        <Input
          type="date"
          value={v.InceptionDate ?? ''}
          onChange={(e) => set({ InceptionDate: e.target.value })}
        />
      </Field>
      <Field label="Tax treatment" hint="Automatic uses the category (Settings → tax rules).">
        <Select
          value={v.TaxClass ?? ''}
          onChange={(e) => set({ TaxClass: (e.target.value || null) as FundForm['TaxClass'] })}
        >
          <option value="">Automatic</option>
          <option value="EQUITY">Equity-oriented</option>
          <option value="DEBT">Debt</option>
          <option value="OTHER">Other (hybrid, FoF, gold…)</option>
        </Select>
      </Field>
      <Field label="Status">
        <Select
          value={v.Status}
          onChange={(e) => set({ Status: e.target.value as FundForm['Status'] })}
        >
          <option value="ACTIVE">Active</option>
          <option value="MERGED">Merged</option>
          <option value="CLOSED">Closed</option>
        </Select>
      </Field>
    </FormGrid>
  );
}

function ManualFund({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<FundForm>(emptyFund);
  const [p, setP] = useState<PlanForm>(emptyPlan);
  const save = () => {
    try {
      const plan = formToPlan(p);
      const id = createFund(f);
      createPlan(id, plan);
      toast('Fund added');
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
      title="Add fund manually"
      footer={<Button onClick={save}>Save</Button>}
    >
      <div className="space-y-5">
        <FundFields v={f} set={(x) => setF((o) => ({ ...o, ...x }))} />
        <div>
          <p className="mb-2 text-sm font-medium">First plan / option</p>
          <PlanFields v={p} set={(x) => setP((o) => ({ ...o, ...x }))} />
        </div>
      </div>
    </Modal>
  );
}

function EditFund({ fundId, onClose }: { fundId: number; onClose: () => void }) {
  const fund = getFund(fundId)!;
  const [f, setF] = useState<FundForm>({ ...emptyFund, ...fund });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Edit ${fund.FundName}`}
      footer={
        <Button
          onClick={() => {
            try {
              updateFund(fundId, f);
              toast('Saved');
              onClose();
            } catch (e) {
              toastError(e);
            }
          }}
        >
          Save
        </Button>
      }
    >
      <FundFields v={f} set={(x) => setF((o) => ({ ...o, ...x }))} />
      <Field label="Notes" className="mt-4">
        <Textarea value={f.Notes ?? ''} onChange={(e) => setF({ ...f, Notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function EditPlan({
  plan,
  fundId,
  onClose,
}: {
  plan: PlanListItem | null;
  fundId: number;
  onClose: () => void;
}) {
  const [p, setP] = useState<PlanForm>(plan ? planToForm(plan) : emptyPlan);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={plan ? `Edit ${planVariant(plan)}` : 'Add plan / option'}
      footer={
        <>
          {plan && plan.TxnCount === 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                try {
                  deletePlan(plan.MutualFundPlanId);
                  onClose();
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Delete
            </Button>
          )}
          <Button
            onClick={() => {
              try {
                if (plan) updatePlan(plan.MutualFundPlanId, formToPlan(p));
                else createPlan(fundId, formToPlan(p));
                toast('Saved');
                onClose();
              } catch (e) {
                toastError(e);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <PlanFields v={p} set={(x) => setP((o) => ({ ...o, ...x }))} />
    </Modal>
  );
}

export function FundsPage() {
  const [showInactive, setShowInactive] = useState(false);
  const plans = useDb(() => listPlans({ includeInactive: showInactive }), [showInactive]);
  const [amfi, setAmfi] = useState(false);
  const [manual, setManual] = useState(false);
  const [editFund, setEditFund] = useState<number | null>(null);
  const [editPlan, setEditPlan] = useState<{ plan: PlanListItem | null; fundId: number } | null>(
    null,
  );

  const funds = useMemo(() => {
    const m = new Map<number, PlanListItem[]>();
    for (const p of plans) m.set(p.MutualFundId, [...(m.get(p.MutualFundId) ?? []), p]);
    return [...m.values()];
  }, [plans]);

  return (
    <>
      <PageHeader
        title="Mutual funds"
        actions={
          <>
            <Checkbox
              label="Show closed"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <Button variant="secondary" onClick={() => setManual(true)}>
              Add manually
            </Button>
            <Button onClick={() => setAmfi(true)}>Add from AMFI</Button>
          </>
        }
      />
      <MFNav />
      {funds.length === 0 ? (
        <EmptyState
          title="No funds yet"
          action={<Button onClick={() => setAmfi(true)}>Search AMFI list</Button>}
        >
          Search the official AMFI list; scheme code, ISIN, plan and option are filled in for you. A
          CAS import also adds funds automatically.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {funds.map((ps) => {
            const f = ps[0];
            return (
              <Card
                key={f.MutualFundId}
                title={
                  <span>
                    {f.FundName}
                    <span className="block text-xs font-normal text-slate-500">
                      {f.AMCName} · {f.Category ?? '—'}
                      {f.SubCategory && ` / ${f.SubCategory}`}
                      {f.RiskLevel && ` · ${f.RiskLevel} risk`}
                    </span>
                  </span>
                }
                actions={
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditFund(f.MutualFundId)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditPlan({ plan: null, fundId: f.MutualFundId })}
                    >
                      + Plan
                    </Button>
                  </>
                }
              >
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {ps.map((p) => (
                    <li
                      key={p.MutualFundPlanId}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <div className="min-w-0">
                        <Link
                          to={`/mf/plans/${p.MutualFundPlanId}`}
                          className="font-medium hover:underline"
                        >
                          {planVariant(p)}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {p.SchemeCode ? `code ${p.SchemeCode}` : 'no scheme code'} ·{' '}
                          {p.ISIN ?? 'no ISIN'}
                          {p.ExpenseRatioBps != null && ` · TER ${formatBps(p.ExpenseRatioBps)}%`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {p.Status !== 'ACTIVE' && (
                          <Badge tone="red">{p.Status.toLowerCase()}</Badge>
                        )}
                        <span className="text-right text-xs text-slate-500">
                          {p.LatestNAV ? (
                            <>
                              <span className="num text-sm text-slate-800 dark:text-slate-200">
                                ₹{formatNav(p.LatestNAV)}
                              </span>
                              <br />
                              {formatDate(p.LatestNAVDate)}
                            </>
                          ) : (
                            'no NAV'
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditPlan({ plan: p, fundId: f.MutualFundId })}
                        >
                          Edit
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
      {amfi && <AmfiSearch onClose={() => setAmfi(false)} />}
      {manual && <ManualFund onClose={() => setManual(false)} />}
      {editFund && <EditFund fundId={editFund} onClose={() => setEditFund(null)} />}
      {editPlan && <EditPlan {...editPlan} onClose={() => setEditPlan(null)} />}
    </>
  );
}
