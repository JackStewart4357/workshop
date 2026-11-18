import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.js'
import AccessDeniedPage from '../pages/AccessDeniedPage.jsx'
import LoadingScreen from './LoadingScreen.jsx'

/**
 * Wraps routes that need a signed-in user, optionally limited to certain roles.
 *   - still checking for a saved session -> spinner
 *   - not signed in                      -> login page (remembering where you were going,
 *                                           unless you just signed out)
 *   - signed in but wrong role           -> "access denied"
 *
 * This only decides what the UI shows. The API checks the token and role on every
 * request, so hiding a page here is a convenience, not the security boundary.
 */
export default function ProtectedRoute({ roles }) {
  const { user, status, sessionEnd } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <LoadingScreen label="Checking your session" />
  if (!user) {
    // A path starting with two slashes ("//somewhere") means "another website" to the router,
    // which refuses to go there and throws. Collapse them so the remembered page is always
    // inside this app.
    const from = (location.pathname + location.search + location.hash).replace(/^[/\\]{2,}/, '/')
    // After a deliberate sign-out nothing is remembered: the next person starts on the dashboard.
    return <Navigate to="/login" replace state={sessionEnd === 'signed-out' ? null : { from }} />
  }
  if (roles && !roles.includes(user.role)) return <AccessDeniedPage />
  return <Outlet />
}
