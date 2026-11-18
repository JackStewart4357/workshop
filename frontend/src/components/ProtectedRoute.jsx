import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.js'
import AccessDeniedPage from '../pages/AccessDeniedPage.jsx'
import LoadingScreen from './LoadingScreen.jsx'

/**
 * Wraps routes that need a signed-in user, optionally limited to certain roles.
 *   - still checking for a saved session -> spinner
 *   - not signed in                      -> login page (remembering where you were going)
 *   - signed in but wrong role           -> "access denied"
 *
 * This only decides what the UI shows. The API checks the token and role on every
 * request, so hiding a page here is a convenience, not the security boundary.
 */
export default function ProtectedRoute({ roles }) {
  const { user, status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <LoadingScreen label="Checking your session" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (roles && !roles.includes(user.role)) return <AccessDeniedPage />
  return <Outlet />
}
