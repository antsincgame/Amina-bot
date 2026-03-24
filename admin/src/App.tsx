import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense, useEffect } from 'react';
import { useAuthStore } from './hooks/useAuth';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const MultimodalSettingsPage = lazy(() => import('./pages/MultimodalSettingsPage'));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const NewsSourcesPage = lazy(() => import('./pages/NewsSourcesPage'));
const VoiceMessagesPage = lazy(() => import('./pages/VoiceMessagesPage'));
const TelephonyPage = lazy(() => import('./pages/TelephonyPage'));
const LMStudioPage = lazy(() => import('./pages/LMStudioPage').then(m => ({ default: m.LMStudioPage })));
const SelfCorePage = lazy(() => import('./pages/SelfCorePage'));
const ReconciliationPage = lazy(() => import('./pages/ReconciliationPage'));

const PageSpinner = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
  </div>
);

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuthStore();

  if (isLoading) return <PageSpinner />;
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
};

const App = () => {
  const cleanup = useAuthStore((state) => state.cleanup);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="self-core" element={<SelfCorePage />} />
            <Route path="reconciliation" element={<ReconciliationPage />} />
            <Route path="lmstudio" element={<LMStudioPage />} />
            <Route path="multimodal" element={<MultimodalSettingsPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="news-sources" element={<NewsSourcesPage />} />
            <Route path="voice-messages" element={<VoiceMessagesPage />} />
            <Route path="telephony" element={<TelephonyPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="logs" element={<LogsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
};

export default App;
