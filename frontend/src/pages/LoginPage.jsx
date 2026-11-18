import { useState } from 'react'
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AuthPageShell from '../components/AuthPageShell.jsx'
import LoadingScreen from '../components/LoadingScreen.jsx'
import PasswordField from '../components/PasswordField.jsx'
import { useAuth } from '../context/AuthContext.js'
import { useFocusAfterFailedSubmit } from '../utils/useFocusAfterFailedSubmit.js'
import { validateEmail, validateForm } from '../utils/validation.js'

const RULES = {
  email: validateEmail,
  password: (value) => (value ? '' : 'Password is required'),
}

export default function LoginPage() {
  const { user, status, sessionEnd, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = location.state?.from || '/'

  const [values, setValues] = useState({ email: '', password: '' })
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tried, setTried] = useState(false) // hides the "session expired" notice for good
  const [formRef, focusAfterFailure] = useFocusAfterFailedSubmit('password')

  // Wait for the start-up session check: a sign-in made while it is still running would
  // be overwritten (or wiped) by its result when it arrives.
  if (status === 'loading') return <LoadingScreen label="Checking your session" />
  if (user) return <Navigate to={destination} replace />

  function handleChange(event) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
    setFieldErrors((current) => ({ ...current, [name]: '' }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setTried(true)
    const errors = validateForm(values, RULES)
    setFieldErrors(errors)
    setFormError('')
    if (Object.keys(errors).length > 0) {
      focusAfterFailure()
      return
    }

    setSubmitting(true)
    try {
      await login(values.email.trim(), values.password)
      navigate(destination, { replace: true })
    } catch (error) {
      setFieldErrors(error.fieldErrors || {})
      // Field-level messages are shown beside the fields; anything else goes in the banner.
      if (!error.fieldErrors || Object.keys(error.fieldErrors).length === 0) setFormError(error.message)
      setSubmitting(false)
      focusAfterFailure()
    }
  }

  return (
    <AuthPageShell title="Sign in" subtitle="Use your ACME account to report and track incidents.">
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        {sessionEnd === 'expired' && !tried && (
          <Alert severity="info" sx={{ mt: 1 }}>
            Your session has expired. Please sign in again.
          </Alert>
        )}
        {formError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {formError}
          </Alert>
        )}
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={values.email}
          onChange={handleChange}
          error={Boolean(fieldErrors.email)}
          helperText={fieldErrors.email}
          disabled={submitting}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          required
          value={values.password}
          onChange={handleChange}
          error={Boolean(fieldErrors.password)}
          helperText={fieldErrors.password}
          disabled={submitting}
        />
        <Button type="submit" variant="contained" size="large" fullWidth loading={submitting} sx={{ mt: 2 }}>
          Sign in
        </Button>
        <Typography sx={{ mt: 2 }}>
          New to the platform?{' '}
          <Link component={RouterLink} to="/register" state={location.state}>
            Create an account
          </Link>
        </Typography>
      </Box>
    </AuthPageShell>
  )
}
