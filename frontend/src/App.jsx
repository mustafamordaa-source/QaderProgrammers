import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import BoardPage from './pages/BoardPage'
import KpiPage from './pages/KpiPage'

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
          <Route path="/kpi" element={<KpiPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/board" replace />} />
      </Routes>
    </AuthProvider>
  )
}
