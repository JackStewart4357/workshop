import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './AuthContext.js'
import { onSessionExpired } from '../services/apiClient.js'
import * as authService from '../services/authService.js'

// Holds "who is signed in" for the whole app. Components read it with useAuth().
export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // 'loading' until we know whether a previous session can be restored, so protected
  // pages do not flash the login screen on every reload.
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    let active = true
    authService.restoreSession().then((restored) => {
      if (!active) return
      setUser(restored)
      setStatus('ready')
    })
    // If the API ever says the session is over, drop the user: protected routes then
    // redirect to the login page.
    onSessionExpired(() => setUser(null))
    return () => {
      active = false
      onSessionExpired(null)
    }
  }, [])

  const login = useCallback(async (email, password) => {
    setUser(await authService.login(email, password))
  }, [])

  const register = useCallback(async (details) => {
    setUser(await authService.register(details))
  }, [])

  const logout = useCallback(async () => {
    await authService.logout()
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, status, login, register, logout }), [user, status, login, register, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
