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
import {
  EMAIL_DOMAIN,
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateCompanyEmail,
  validateForm,
  validateNewPassword,
  validateRequired,
} from '../utils/validation.js'

// The API calls the name field full_name; the form uses the same key so its error
// messages land on the right input without any mapping.
const EMPTY = { full_name: '', email: '', password: '', confirmPassword: '' }

export default function RegisterPage() {
  const { user, status, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = location.state?.from || '/'

  const [values, setValues] = useState(EMPTY)
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formRef, focusAfterFailure] = useFocusAfterFailedSubmit('full_name')

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
    const errors = validateForm(values, {
      full_name: validateRequired('Full name', NAME_MAX_LENGTH),
      email: validateCompanyEmail,
      password: validateNewPassword,
      confirmPassword: (value) => (value === values.password ? '' : 'Passwords do not match'),
    })
    setFieldErrors(errors)
    setFormError('')
    if (Object.keys(errors).length > 0) {
      focusAfterFailure()
      return
    }

    setSubmitting(true)
    try {
      await register({ fullName: values.full_name.trim(), email: values.email.trim(), password: values.password })
      navigate(destination, { replace: true })
    } catch (error) {
      setFieldErrors(error.fieldErrors || {})
      if (!error.fieldErrors || Object.keys(error.fieldErrors).length === 0) setFormError(error.message)
      setSubmitting(false)
      focusAfterFailure()
    }
  }

  return (
    <AuthPageShell title="Create your account" subtitle={`Registration is open to @${EMAIL_DOMAIN} email addresses.`}>
      <Box component="form" ref={formRef} noValidate onSubmit={handleSubmit}>
        {formError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {formError}
          </Alert>
        )}
        <TextField
          label="Full name"
          name="full_name"
          autoComplete="name"
          autoFocus
          required
          value={values.full_name}
          onChange={handleChange}
          error={Boolean(fieldErrors.full_name)}
          helperText={fieldErrors.full_name}
          disabled={submitting}
        />
        <TextField
          label="Work email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={values.email}
          onChange={handleChange}
          error={Boolean(fieldErrors.email)}
          helperText={fieldErrors.email || `Must end in @${EMAIL_DOMAIN}`}
          disabled={submitting}
        />
        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          required
          value={values.password}
          onChange={handleChange}
          error={Boolean(fieldErrors.password)}
          helperText={fieldErrors.password || `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number`}
          disabled={submitting}
        />
        <PasswordField
          label="Confirm password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={values.confirmPassword}
          onChange={handleChange}
          error={Boolean(fieldErrors.confirmPassword)}
          helperText={fieldErrors.confirmPassword}
          disabled={submitting}
        />
        <Button type="submit" variant="contained" size="large" fullWidth loading={submitting} sx={{ mt: 2 }}>
          Create account
        </Button>
        <Typography sx={{ mt: 2 }}>
          Already registered?{' '}
          <Link component={RouterLink} to="/login" state={location.state}>
            Sign in
          </Link>
        </Typography>
      </Box>
    </AuthPageShell>
  )
}
