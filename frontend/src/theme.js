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
    // Long names wrap instead of being cut off in a drop-down or pushing a page sideways on a phone
    MuiMenuItem: { styleOverrides: { root: { whiteSpace: 'normal', overflowWrap: 'anywhere' } } },
    MuiDialogTitle: { styleOverrides: { root: { overflowWrap: 'anywhere' } } },
    MuiTypography: { styleOverrides: { h1: { overflowWrap: 'anywhere' } } },
  },
})

export default theme
