import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { api } from './api.js';
import { startRealtime } from './realtime.js';
import { mergePrefs, DEFAULT_PREFS } from './prefs.js';
import { mergeWorkspace, DEFAULT_WORKSPACE, CODE_INTELLIGENCE_READONLY } from './workspace.js';
import { setMaxFileBytes } from './uploadStore.js';
import { startPerfCollector, stopPerfCollector } from './perf.js';
import { useActiveWindow } from './useActiveWindow.js';
import { windowId } from './activeWindow.js';

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    user: null,
    workspaceName: DEFAULT_WORKSPACE.name,
    workspace: DEFAULT_WORKSPACE,
  });

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/auth/me', { noRedirect: true });
      setState({
        loading: false,
        user: data.user,
        workspaceName: data.workspaceName,
        workspace: mergeWorkspace(data.workspace),
      });
    } catch {
      setState((s) => ({ ...s, loading: false, user: null }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // One window per account: this owns the claim and tells the app whether to
  // render normally or hand over to the takeover overlay.
  const activeWindow = useActiveWindow(state.user?.id);
  const onActiveWindowEvent = activeWindow.onServerEvent;

  // Live updates: when an admin changes this user's workspace role or their
  // membership in a space, push it straight into the UI instead of waiting for
  // them to reload. Screens listen on the same window events they already use
  // for local changes.
  useEffect(() => {
    if (!state.user) return undefined;
    return startRealtime((type, detail) => {
      switch (type) {
        case 'account-changed':
          // May also mean "deactivated" — refresh() then 401s and drops them to /login.
          refresh();
          // A workspace role change moves access in every space at once, so
          // re-check the spaces and whatever is open (no spaceId == "all").
          emit('spaces-changed', {});
          emit('space-members-changed', {});
          notifications.show({ message: 'Your workspace access was updated.' });
          break;
        case 'spaces-changed':
          emit('spaces-changed', detail);
          break;
        case 'space-members-changed':
          emit('space-members-changed', detail);
          break;
        case 'users-changed':
          emit('users-changed', detail);
          break;
        case 'pages-changed':
          // Someone rearranged a tree. Screens already listen on this channel
          // for their own edits, so the sidebar redraws and every [[link]] chip
          // re-resolves the URL it renders.
          emit('pages-changed', detail);
          break;
        case 'page-moved':
          // A page changed space, which changes its URL. Whoever has it open
          // reroutes; everyone else has already been covered by 'pages-changed'.
          emit('page-moved', detail);
          break;
        case 'workspace-settings-changed':
          // Workspace-wide switches take effect everywhere at once: the payload
          // carries the new settings, so no refetch is needed.
          setState((s) => ({
            ...s,
            workspace: mergeWorkspace(detail.workspace),
            workspaceName: detail.workspace?.name || s.workspaceName,
          }));
          break;
        case 'active-window-changed':
          // Somebody claimed the account. The payload names the winning window,
          // so this tab can tell straight away whether it is still the one.
          onActiveWindowEvent(detail);
          break;
        case 'reconnected':
          // Anything pushed while the stream was down was missed; re-sync.
          refresh();
          emit('spaces-changed', {});
          emit('users-changed', {});
          emit('space-members-changed', {});
          emit('pages-changed', {});
          // The claim may have moved while the stream was down.
          onActiveWindowEvent({});
          break;
        default:
          break;
      }
    });
  }, [state.user?.id, refresh, onActiveWindowEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  // The collector follows the workspace switch, in this tab and in every other
  // one: an admin turning logging off stops browsers that are already open,
  // because the same settings event that updates the state runs this effect.
  const { logging: perfLogging, sampleRate: perfSampleRate } = state.workspace.performance;
  useEffect(() => {
    if (!state.user || !perfLogging) {
      stopPerfCollector();
      return undefined;
    }
    startPerfCollector({ sampleRate: perfSampleRate });
    return () => stopPerfCollector({ drain: true });
  }, [state.user?.id, perfLogging, perfSampleRate]); // eslint-disable-line react-hooks/exhaustive-deps

  // The upload store is plain module state — editor code reaches it from
  // outside React — so the workspace ceiling is pushed into it here. Same event
  // that updates this state updates it in every other open tab, so lowering the
  // limit starts refusing big files without a reload.
  const maxFileBytes = state.workspace.uploads.maxBytes;
  useEffect(() => setMaxFileBytes(maxFileBytes), [maxFileBytes]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout', { clientId: windowId() });
    location.assign('/login');
  }, []);

  const isAdmin = state.user && ['owner', 'admin'].includes(state.user.role);
  const preferences = mergePrefs(state.user?.preferences);

  const updatePreferences = useCallback(
    async (partial) => {
      const next = { ...mergePrefs(state.user?.preferences), ...partial };
      setState((s) => (s.user ? { ...s, user: { ...s.user, preferences: next } } : s));
      await api.patch('/api/auth/preferences', { preferences: next });
    },
    [state.user?.preferences] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const updatePerformance = useCallback(async (partial) => {
    const data = await api.patch('/api/workspace/settings/performance', { performance: partial });
    setState((s) => ({ ...s, workspace: mergeWorkspace(data.workspace) }));
    return data.workspace;
  }, []);

  // Admin-only rename. The header reads `workspaceName`, so update both it and
  // the settings blob rather than waiting for the SSE echo.
  const updateWorkspaceName = useCallback(async (name) => {
    const data = await api.patch('/api/workspace/settings/name', { name });
    setState((s) => ({
      ...s,
      workspace: mergeWorkspace(data.workspace),
      workspaceName: data.workspace.name,
    }));
    return data.workspace;
  }, []);

  // Admin-only write; every browser (including this one) picks the change up
  // again over SSE, which is what keeps other tabs in step.
  const updateDataSavings = useCallback(async (partial) => {
    const data = await api.patch('/api/workspace/settings/data-savings', { dataSavings: partial });
    setState((s) => ({ ...s, workspace: mergeWorkspace(data.workspace) }));
    return data.workspace;
  }, []);

  // Admin-only, same pattern as the two above. Editors already open pick the
  // change up over SSE, which is what makes the switch take effect without a
  // reload in every other browser too.
  const updateCodeIntelligence = useCallback(async (partial) => {
    const data = await api.patch('/api/workspace/settings/code-intelligence', {
      codeIntelligence: partial,
    });
    setState((s) => ({ ...s, workspace: mergeWorkspace(data.workspace) }));
    return data.workspace;
  }, []);

  // Admin-only, same pattern as the groups above.
  const updateUploads = useCallback(async (partial) => {
    const data = await api.patch('/api/workspace/settings/uploads', { uploads: partial });
    setState((s) => ({ ...s, workspace: mergeWorkspace(data.workspace) }));
    return data.workspace;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        refresh,
        logout,
        isAdmin,
        preferences,
        updatePreferences,
        dataSavings: state.workspace.dataSavings,
        updateDataSavings,
        performanceSettings: state.workspace.performance,
        updatePerformance,
        codeIntelligence: state.workspace.codeIntelligence,
        updateCodeIntelligence,
        uploads: state.workspace.uploads,
        updateUploads,
        updateWorkspaceName,
        activeWindow,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Safe outside AuthProvider (public share pages): falls back to defaults.
export const useAuth = () =>
  useContext(AuthContext) || {
    user: null,
    preferences: DEFAULT_PREFS,
    workspace: DEFAULT_WORKSPACE,
    dataSavings: DEFAULT_WORKSPACE.dataSavings,
    performanceSettings: DEFAULT_WORKSPACE.performance,
    // Outside a provider means a public share page: colour the code, check
    // nothing.
    codeIntelligence: CODE_INTELLIGENCE_READONLY,
    uploads: DEFAULT_WORKSPACE.uploads,
    // No account outside the provider, so nothing to hold a claim on.
    activeWindow: { status: 'active', holder: null, switching: false, takeOver: () => {} },
  };
