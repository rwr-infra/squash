import { useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Spin, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import InstanceListPage from './pages/InstanceListPage';
import TerminalPage from './pages/TerminalPage';
import LoginPage from './pages/LoginPage';
import { getAuthStatus, getToken, UNAUTHORIZED_EVENT } from './services/apiService';

const RequireAuth = ({ children }: { children: ReactNode }) => {
  const location = useLocation();
  const { data, isLoading } = useQuery({
    queryKey: ['auth-status'],
    queryFn: getAuthStatus,
    staleTime: Infinity
  });

  if (isLoading) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin />
      </div>
    );
  }

  // Login disabled (no credentials configured) → open access.
  if (!data?.loginEnabled) return <>{children}</>;
  // Login enabled but no token → redirect to login, remembering where we were.
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
};

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  // Global 401 handler: any authenticated request that comes back 401 (expired or
  // revoked session) drops the token, toasts, and forces a redirect to /login.
  useEffect(() => {
    const onUnauthorized = () => {
      if (location.pathname === '/login') return;
      message.error('Session expired — please log in again');
      queryClient.clear();
      navigate('/login', { replace: true, state: { from: location.pathname } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, location.pathname, queryClient]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><InstanceListPage /></RequireAuth>} />
      <Route path="/terminal/:instanceId" element={<RequireAuth><TerminalPage /></RequireAuth>} />
    </Routes>
  );
}

export default App;
