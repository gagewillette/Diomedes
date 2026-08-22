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
import WorkspaceSettings from './pages/WorkspaceSettings.jsx';
import WorkspaceInfo from './pages/WorkspaceInfo.jsx';
import SharePage from './pages/SharePage.jsx';
import { onNavigate } from './lib/api.js';
import { DiagramLightboxHost } from './editor/DiagramLightbox';
import InactiveWindowOverlay from './components/InactiveWindowOverlay.jsx';

function Protected({ children }) {
  const { loading, user, activeWindow } = useAuth();
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
  // The account is open in another window. The app still mounts underneath —
  // taking the session over should drop the user back into what they were
  // looking at, not reload them to the top — but the overlay covers it and
  // `inert` keeps keyboard and pointer out of a view they are not driving.
  const blocked = activeWindow?.status === 'blocked';
  return (
    <>
      {/* display:contents so this wrapper never becomes a box of its own —
          Layout's full-height shell has to keep laying out as if it were the
          direct child, blocked or not. */}
      <div
        style={{ display: 'contents' }}
        inert={blocked ? '' : undefined}
        aria-hidden={blocked || undefined}
      >
        {children}
      </div>
      {blocked && (
        <InactiveWindowOverlay
          holder={activeWindow.holder}
          switching={activeWindow.switching}
          onSwitch={activeWindow.takeOver}
        />
      )}
    </>
  );
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
      {/* one viewer for every diagram on the page — see DiagramLightbox */}
      <DiagramLightboxHost />
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
                  <Route path="/settings/workspace" element={<WorkspaceSettings />} />
                  <Route path="/settings/workspace/info" element={<WorkspaceInfo />} />
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
