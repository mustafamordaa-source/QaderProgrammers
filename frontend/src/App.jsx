import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import BoardPage from './pages/BoardPage'
import KpiPage from './pages/KpiPage'
import UsersPage from './pages/UsersPage'
import InboxPage from './pages/InboxPage'
import SettingsPage from './pages/SettingsPage'
import DocumentsPage from './pages/DocumentsPage'
import GuidePage from './pages/GuidePage'

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/board" element={<BoardPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/metrics" element={<KpiPage />} />
          <Route
            path="/people"
            element={
              <ProtectedRoute leadOnly>
                <UsersPage />
              </ProtectedRoute>
            }
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/guide" element={<GuidePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/board" replace />} />
      </Routes>
    </AuthProvider>
  )
}
