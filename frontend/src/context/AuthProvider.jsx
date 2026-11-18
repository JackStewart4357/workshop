import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './AuthContext.js'
import { onSessionExpired, onSessionRefreshed } from '../services/apiClient.js'
import * as authService from '../services/authService.js'

// Holds "who is signed in" for the whole app. Components read it with useAuth().
export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // 'loading' until we know whether a previous session can be restored, so protected
  // pages do not flash the login screen on every reload.
  const [status, setStatus] = useState('loading')
  // How the last session ended. 'expired': the login page explains why it appeared.
  // 'signed-out': the next sign-in starts on the dashboard, not on the page the last
  // person was looking at.
  const [sessionEnd, setSessionEnd] = useState(null)

  useEffect(() => {
    let active = true
    // If the API ever says the session is over, drop the user: protected routes then
    // redirect to the login page.
    onSessionExpired(() => {
      setUser(null)
      // Keep 'signed-out': a request sent before a sign-out can still come back 401 after it
      setSessionEnd((end) => end ?? 'expired')
    })
    // Tabs share one refresh token, so renewing it can return another account (signed in
    // from a different tab) or a changed role: always show the user the tokens belong to.
    onSessionRefreshed(setUser)
    authService.restoreSession().then((restored) => {
      if (!active) return
      setUser(restored)
      setStatus('ready')
    })
    return () => {
      active = false
      onSessionExpired(null)
      onSessionRefreshed(null)
    }
  }, [])

  const login = useCallback(async (email, password) => {
    setUser(await authService.login(email, password))
    setSessionEnd(null)
  }, [])

  const register = useCallback(async (details) => {
    setUser(await authService.register(details))
    setSessionEnd(null)
  }, [])

  const logout = useCallback(async () => {
    await authService.logout()
    setUser(null)
    // Set last: signing out of a session that had already expired is still a sign-out
    setSessionEnd('signed-out')
  }, [])

  const value = useMemo(
    () => ({ user, status, sessionEnd, login, register, logout }),
    [user, status, sessionEnd, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
