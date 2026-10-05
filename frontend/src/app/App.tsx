import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { Spinner } from '@/components/ui';
import { Toaster } from '@/components/toast';
import {
  CreateVault,
  FatalError,
  Login,
  ServerSetup,
  Unlock,
} from '@/features/onboarding/Onboarding';
import { Dashboard } from '@/features/dashboard/Dashboard';
import { FamilyPage } from '@/features/family/FamilyPage';
import { BanksPage } from '@/features/banks/BanksPage';
import { AccountsPage } from '@/features/accounts/AccountsPage';
import { AccountDetail } from '@/features/accounts/AccountDetail';
import { TransactionsPage } from '@/features/transactions/TransactionsPage';
import { ImportPage } from '@/features/import/ImportPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { MFDashboard } from '@/features/mf/MFDashboard';
import { PortfolioPage } from '@/features/mf/PortfolioPage';
import { SipsPage } from '@/features/mf/SipsPage';
import { MFTransactionsPage } from '@/features/mf/MFTransactionsPage';
import { FundsPage } from '@/features/mf/FundsPage';
import { AccountsFoliosPage } from '@/features/mf/AccountsFoliosPage';
import { GainsPage } from '@/features/mf/GainsPage';
import { MFImportPage } from '@/features/mf/MFImportPage';
import { FundDetail } from '@/features/mf/FundDetail';
import { Layout } from './Layout';
import { appState, refreshPhase } from './session';
import { useTheme } from './theme';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/family', element: <FamilyPage /> },
      { path: '/banks', element: <BanksPage /> },
      { path: '/accounts', element: <AccountsPage /> },
      { path: '/accounts/:id', element: <AccountDetail /> },
      { path: '/transactions', element: <TransactionsPage /> },
      { path: '/import', element: <ImportPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/mf', element: <MFDashboard /> },
      { path: '/mf/portfolio', element: <PortfolioPage /> },
      { path: '/mf/sips', element: <SipsPage /> },
      { path: '/mf/transactions', element: <MFTransactionsPage /> },
      { path: '/mf/funds', element: <FundsPage /> },
      { path: '/mf/accounts', element: <AccountsFoliosPage /> },
      { path: '/mf/gains', element: <GainsPage /> },
      { path: '/mf/import', element: <MFImportPage /> },
      { path: '/mf/plans/:id', element: <FundDetail /> },
      { path: '*', element: <Dashboard /> },
    ],
  },
]);

export function App() {
  useTheme();
  const { phase, error } = useStore(appState);
  useEffect(() => {
    void refreshPhase();
  }, []);

  let content;
  switch (phase) {
    case 'loading':
      content = (
        <div className="flex min-h-dvh items-center justify-center text-slate-500">
          <Spinner className="size-6" />
        </div>
      );
      break;
    case 'server-setup':
      content = <ServerSetup />;
      break;
    case 'login':
      content = <Login />;
      break;
    case 'create-vault':
      content = <CreateVault />;
      break;
    case 'locked':
      content = <Unlock error={error} />;
      break;
    case 'error':
      content = <FatalError error={error} />;
      break;
    case 'unlocked':
      content = <RouterProvider router={router} />;
  }
  return (
    <>
      {content}
      <Toaster />
    </>
  );
}
