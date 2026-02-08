import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './hooks/useAuth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';
import MultimodalSettingsPage from './pages/MultimodalSettingsPage';
import ApiKeysPage from './pages/ApiKeysPage';
import PromptsPage from './pages/PromptsPage';
import AnalyticsPage from './pages/AnalyticsPage';
import LogsPage from './pages/LogsPage';
import UsersPage from './pages/UsersPage';
import NewsSourcesPage from './pages/NewsSourcesPage';
import VoiceMessagesPage from './pages/VoiceMessagesPage';
import { ErrorBoundary } from './components/ErrorBoundary';

// Protected Route wrapper
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const App = () => {
  return (
    <ErrorBoundary>
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
          <Route path="multimodal" element={<MultimodalSettingsPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="prompts" element={<PromptsPage />} />
          <Route path="news-sources" element={<NewsSourcesPage />} />
          <Route path="voice-messages" element={<VoiceMessagesPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="logs" element={<LogsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
};

export default App;
