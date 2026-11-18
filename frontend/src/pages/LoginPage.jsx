import { useState } from 'react'
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AuthPageShell from '../components/AuthPageShell.jsx'
import PasswordField from '../components/PasswordField.jsx'
import { useAuth } from '../context/AuthContext.js'
import { validateEmail, validateForm } from '../utils/validation.js'

const RULES = {
  email: validateEmail,
  password: (value) => (value ? '' : 'Password is required'),
}

export default function LoginPage() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const destination = location.state?.from || '/'

  const [values, setValues] = useState({ email: '', password: '' })
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (user) return <Navigate to={destination} replace />

  function handleChange(event) {
    const { name, value } = event.target
    setValues((current) => ({ ...current, [name]: value }))
    setFieldErrors((current) => ({ ...current, [name]: '' }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const errors = validateForm(values, RULES)
    setFieldErrors(errors)
    setFormError('')
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)
    try {
      await login(values.email.trim(), values.password)
      navigate(destination, { replace: true })
    } catch (error) {
      setFieldErrors(error.fieldErrors || {})
      // Field-level messages are shown beside the fields; anything else goes in the banner.
      if (!error.fieldErrors || Object.keys(error.fieldErrors).length === 0) setFormError(error.message)
      setSubmitting(false)
    }
  }

  return (
    <AuthPageShell title="Sign in" subtitle="Use your ACME account to report and track incidents.">
      <Box component="form" noValidate onSubmit={handleSubmit}>
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
