import { createTheme } from '@mui/material/styles'

// One place for colours, type and component defaults so every screen looks the same.
const theme = createTheme({
  palette: {
    primary: { main: '#1f4e79' },
    secondary: { main: '#b45309' },
    background: { default: '#f4f6f8' },
  },
  shape: { borderRadius: 8 },
  typography: {
    h1: { fontSize: '1.75rem', fontWeight: 600 },
    h2: { fontSize: '1.25rem', fontWeight: 600 },
  },
  components: {
    MuiTextField: { defaultProps: { fullWidth: true, margin: 'normal' } },
    MuiButton: { defaultProps: { disableElevation: true } },
  },
})

export default theme
