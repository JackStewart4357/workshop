import { createContext, useContext } from 'react'

// Shape: { user, status: 'loading' | 'ready', login, register, logout }
export const AuthContext = createContext(null)

/** The signed-in user and the actions that change it. */
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
