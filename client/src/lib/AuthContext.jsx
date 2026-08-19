import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { api } from './api.js';
import { startRealtime } from './realtime.js';
import { mergePrefs, DEFAULT_PREFS } from './prefs.js';

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, workspaceName: 'Diomedes' });

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/auth/me', { noRedirect: true });
      setState({ loading: false, user: data.user, workspaceName: data.workspaceName });
    } catch {
      setState((s) => ({ ...s, loading: false, user: null }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
        case 'reconnected':
          // Anything pushed while the stream was down was missed; re-sync.
          refresh();
          emit('spaces-changed', {});
          emit('users-changed', {});
          emit('space-members-changed', {});
          break;
        default:
          break;
      }
    });
  }, [state.user?.id, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
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

  return (
    <AuthContext.Provider
      value={{ ...state, refresh, logout, isAdmin, preferences, updatePreferences }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Safe outside AuthProvider (public share pages): falls back to defaults.
export const useAuth = () => useContext(AuthContext) || { user: null, preferences: DEFAULT_PREFS };
