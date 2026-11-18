import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useMediaQuery } from 'react-responsive'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import LogoutIcon from '@mui/icons-material/Logout'
import MenuIcon from '@mui/icons-material/Menu'
import { useAuth } from '../context/AuthContext.js'
import { ROLE_LABELS, navItemsFor } from '../navigation.js'

const DRAWER_WIDTH = 240
const MOBILE_QUERY = { maxWidth: 899 }

/**
 * The frame around every signed-in page: top bar, side menu and the page itself.
 * On wide screens the menu is always visible; on phones it slides in from a button.
 */
export default function AppLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const [menuOpen, setMenuOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  async function handleLogout() {
    setSigningOut(true)
    await logout()
    navigate('/login', { replace: true })
  }

  const menu = (
    <Box component="nav" aria-label="Main">
      <List>
        {navItemsFor(user.role).map(({ label, path, icon: Icon }) => (
          <ListItemButton
            key={path}
            component={NavLink}
            to={path}
            end={path === '/'}
            onClick={() => setMenuOpen(false)}
            sx={{ '&.active': { bgcolor: 'action.selected', fontWeight: 600 } }}
          >
            <ListItemIcon>
              <Icon />
            </ListItemIcon>
            <ListItemText primary={label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  )

  return (
    <Box sx={{ display: 'flex', minHeight: '100%' }}>
      <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
        <Toolbar>
          {isMobile && (
            <IconButton
              color="inherit"
              edge="start"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              sx={{ mr: 1 }}
            >
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" component="p" noWrap sx={{ flexGrow: 1 }}>
            ACME Facility Incidents
          </Typography>
          {!isMobile && (
            <Typography noWrap sx={{ mr: 1.5 }}>
              {user.full_name}
            </Typography>
          )}
          <Chip
            label={ROLE_LABELS[user.role] ?? user.role}
            size="small"
            sx={{ mr: 1, bgcolor: 'rgba(255,255,255,0.18)', color: 'inherit' }}
          />
          {isMobile ? (
            <IconButton color="inherit" aria-label="Sign out" onClick={handleLogout} disabled={signingOut}>
              <LogoutIcon />
            </IconButton>
          ) : (
            <Button color="inherit" startIcon={<LogoutIcon />} onClick={handleLogout} disabled={signingOut}>
              Sign out
            </Button>
          )}
        </Toolbar>
      </AppBar>

      {isMobile ? (
        <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} ModalProps={{ keepMounted: true }}>
          <Box sx={{ width: DRAWER_WIDTH }}>
            <Toolbar>
              <Typography noWrap>{user.full_name}</Typography>
            </Toolbar>
            {menu}
          </Box>
        </Drawer>
      ) : (
        <Drawer variant="permanent" sx={{ width: DRAWER_WIDTH, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}>
          <Toolbar />
          {menu}
        </Drawer>
      )}

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, sm: 3 } }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  )
}
