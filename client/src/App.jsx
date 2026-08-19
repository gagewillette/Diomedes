import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';
import { AuthProvider, useAuth } from './lib/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Setup from './pages/Setup.jsx';
import Home from './pages/Home.jsx';
import SpaceHome from './pages/SpaceHome.jsx';
import PageEditor from './pages/PageEditor.jsx';
import Settings from './pages/Settings.jsx';
import MembersAdmin from './pages/MembersAdmin.jsx';
import SharePage from './pages/SharePage.jsx';
import { onNavigate } from './lib/api.js';

function Protected({ children }) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (!user) {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?from=${from}`} replace />;
  }
  return children;
}

// Wiki links are rendered deep inside the editor, which also mounts on public
// share pages. They ask for navigation by event; this answers from inside the
// router so a click stays a client-side transition instead of a full reload.
function InternalLinkNavigation() {
  const navigate = useNavigate();
  useEffect(() => onNavigate((e) => navigate(e.detail.to)), [navigate]);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <InternalLinkNavigation />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/share/:token" element={<SharePage />} />
        <Route
          path="/*"
          element={
            <Protected>
              <Layout>
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/s/:slug" element={<SpaceHome />} />
                  <Route path="/s/:slug/p/:pageId" element={<PageEditor />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/settings/members" element={<MembersAdmin />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </Protected>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
