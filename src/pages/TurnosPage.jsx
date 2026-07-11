import { useAuth } from '../contexts/AuthContext'
import { LogOut, CalendarDays, BarChart2, LayoutGrid, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import VipMisTurnos from './VipMisTurnos'

export default function TurnosPage() {
  const { profile, signOut } = useAuth()
  const esAdmin = ['admin', 'supervisor'].includes(profile?.role)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header minimal */}
      <header className="bg-white border-b border-gray-200 h-14 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-50">
        <div className="flex items-center gap-2.5">
          <img src="/logosomos.png" alt="Somos Internet" className="h-7" />
          <div className="hidden sm:block w-px h-5 bg-gray-200" />
          <div className="flex items-center gap-1">
            <Link to="/" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary-50 text-primary-700 transition">
              <CalendarDays className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Turnos</span>
            </Link>
            {esAdmin && (
              <Link to="/wfm" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition">
                <BarChart2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">WFM</span>
              </Link>
            )}
            {esAdmin && (
              <Link to="/admin" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition">
                <Users className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Usuarios</span>
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-xs text-gray-500 hidden sm:block">{profile?.full_name}</p>
          <button
            onClick={signOut}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-500 transition px-2 py-1.5 rounded-lg hover:bg-red-50">
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      {/* Contenido: VipMisTurnos ya maneja sus propias pestañas */}
      <main>
        <VipMisTurnos />
      </main>
    </div>
  )
}
