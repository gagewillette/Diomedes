import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import { mergePrefs, DEFAULT_PREFS } from './prefs.js';

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
