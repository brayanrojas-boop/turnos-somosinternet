import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { getProfiles, updateProfile } from '../lib/vip'
import {
  LogOut, CalendarDays, BarChart2, LayoutGrid, Users,
  Search, X, Pencil, CheckCircle, AlertCircle,
} from 'lucide-react'

const ROLES = [
  { value: 'agente',     label: 'Agente' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'admin',      label: 'Admin' },
  { value: 'kam',        label: 'KAM' },
]

function roleBadge(role) {
  const map = {
    admin:      'bg-red-100 text-red-700',
    supervisor: 'bg-purple-100 text-purple-700',
    kam:        'bg-blue-100 text-blue-700',
    agente:     'bg-gray-100 text-gray-600',
  }
  return map[role] ?? 'bg-gray-100 text-gray-500'
}

export default function AdminPage() {
  const { profile, user, signOut } = useAuth()
  const esAdmin = ['admin', 'supervisor'].includes(profile?.role)
  const esPropietario = user?.email === 'brayan.rojas@somosinternet.co'

  const [usuarios, setUsuarios]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [busqueda, setBusqueda]   = useState('')
  const [filtroRol, setFiltroRol] = useState('')

  const [modal, setModal]         = useState(null)  // usuario editando
  const [form, setForm]           = useState({})
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)  // { ok, text }

  useEffect(() => {
    if (!esAdmin) return
    cargar()
  }, [esAdmin])

  async function cargar() {
    setLoading(true)
    try {
      const data = await getProfiles()
      setUsuarios(data)
    } catch(e) {
      showToast(false, e.message)
    }
    setLoading(false)
  }

  function showToast(ok, text) {
    setToast({ ok, text })
    setTimeout(() => setToast(null), 4000)
  }

  function abrirModal(u) {
    setModal(u)
    setForm({
      full_name:    u.full_name   ?? '',
      role:         u.role        ?? 'agente',
      nombre_turno: u.nombre_turno ?? '',
    })
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await updateProfile(modal.id, {
        full_name:    form.full_name.trim(),
        role:         form.role,
        nombre_turno: form.nombre_turno.trim() || null,
      })
      await cargar()
      setModal(null)
      showToast(true, 'Usuario actualizado correctamente')
    } catch(e) {
      showToast(false, e.message)
    }
    setSaving(false)
  }

  const filtrados = usuarios.filter(u => {
    const q = busqueda.toLowerCase()
    const coincide = !q || u.full_name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.nombre_turno?.toLowerCase().includes(q)
    const rolOk = !filtroRol || u.role === filtroRol
    return coincide && rolOk
  })

  if (!esAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
        No tienes permisos para ver esta página
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 h-14 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-50">
        <div className="flex items-center gap-2.5">
          <img src="/logosomos.png" alt="Somos Internet" className="h-7" />
          <div className="hidden sm:block w-px h-5 bg-gray-200" />
          <div className="flex items-center gap-1">
            <Link to="/" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition">
              <CalendarDays className="w-3.5 h-3.5" /><span className="hidden sm:inline">Turnos</span>
            </Link>
            {esAdmin && (
              <Link to="/wfm" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition">
                <BarChart2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">WFM</span>
              </Link>
            )}
            {esAdmin && (
              <Link to="/asignacion" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100 transition">
                <LayoutGrid className="w-3.5 h-3.5" /><span className="hidden sm:inline">Asignación</span>
              </Link>
            )}
            {esAdmin && (
              <Link to="/admin" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary-50 text-primary-700 transition">
                <Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">Usuarios</span>
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <p className="text-xs text-gray-500 hidden sm:block">{profile?.full_name}</p>
          <button onClick={signOut} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-500 transition px-2 py-1.5 rounded-lg hover:bg-red-50">
            <LogOut className="w-3.5 h-3.5" /><span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      <main className="p-4 lg:p-6 max-w-6xl mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Users className="w-5 h-5 text-primary-600" /> Usuarios
          </h1>
          <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">
            {filtrados.length} usuario{filtrados.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por nombre o email…"
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {busqueda && (
              <button onClick={() => setBusqueda('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <select
            value={filtroRol}
            onChange={e => setFiltroRol(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">Todos los roles</option>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {/* Tabla */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-5 h-5 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtrados.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">No se encontraron usuarios</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Nombre</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide hidden sm:table-cell">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Rol</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide hidden md:table-cell">Nombre en turno</th>
                  <th className="px-4 py-3 w-28"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtrados.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50 transition">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{u.full_name || <span className="text-gray-400 italic">Sin nombre</span>}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{u.email || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${roleBadge(u.role)}`}>
                        {ROLES.find(r => r.value === u.role)?.label ?? u.role ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{u.nombre_turno || <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          onClick={() => abrirModal(u)}
                          title="Editar"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* Modal editar usuario */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={e => e.target === e.currentTarget && setModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-gray-800">Editar usuario</h3>
              <button onClick={() => setModal(null)}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
            </div>

            {modal.email && (
              <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2 mb-4 font-mono">{modal.email}</p>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombre completo</label>
                <input
                  type="text"
                  required
                  value={form.full_name}
                  onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Rol</label>
                <select
                  value={form.role}
                  onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Nombre en turno
                  <span className="text-gray-400 font-normal ml-1">(como aparece en el Google Sheet)</span>
                </label>
                <input
                  type="text"
                  value={form.nombre_turno}
                  onChange={e => setForm(p => ({ ...p, nombre_turno: e.target.value }))}
                  placeholder="Ej: Juan Carlos Pérez"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <div className="flex gap-3">
                <button type="button" onClick={() => setModal(null)}
                  className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">
                  Cancelar
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition">
                  {saving ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all
          ${toast.ok ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.ok
            ? <CheckCircle className="w-4 h-4 shrink-0" />
            : <AlertCircle className="w-4 h-4 shrink-0" />}
          {toast.text}
        </div>
      )}
    </div>
  )
}
