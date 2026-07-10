import { useState, useCallback, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  getFranjas, saveFranja, deleteFranja,
  getNovedades, saveNovedad, deleteNovedad,
  getAgentesLinea, getTurnosSemanaAsignacion,
  asignarAFranja, desasignarDeFranja,
} from '../lib/asignacion'
import { getLineasActivas } from '../lib/vip'
import {
  ChevronLeft, ChevronRight, Plus, X, CalendarDays,
  BarChart2, LogOut, AlertCircle, User, LayoutGrid,
} from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function getLunes(date) {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day))
  d.setHours(0,0,0,0)
  return d
}
function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d
}
function fmt(t) { return t ? t.slice(0,5) : '' }

const DIAS_CORTO = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']
const TIPOS_NOVEDAD = ['VACACION','LICENCIA','PERMISO','INCAPACIDAD','OTRO']
const COLOR_NOVEDAD = {
  VACACION: 'bg-blue-100 text-blue-700',
  LICENCIA: 'bg-purple-100 text-purple-700',
  INCAPACIDAD: 'bg-red-100 text-red-700',
  PERMISO: 'bg-orange-100 text-orange-700',
  OTRO: 'bg-gray-100 text-gray-600',
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function AsignacionPage() {
  const { profile, user, signOut } = useAuth()
  const esAdmin = ['admin','supervisor'].includes(profile?.role)
  const esPropietario = user?.email === 'brayan.rojas@somosinternet.co'

  const [tab, setTab]       = useState('asignacion')
  const [linea, setLinea]   = useState('')
  const [lineas, setLineas] = useState([])
  const [lunes, setLunes]   = useState(() => getLunes(new Date()))

  const [franjas, setFranjas]           = useState([])
  const [turnosSemana, setTurnosSemana] = useState([])
  const [novedades, setNovedades]       = useState([])
  const [roster, setRoster]             = useState([])
  const [loading, setLoading]           = useState(false)
  const [saving, setSaving]             = useState(false)

  // Modales
  const [modalCelda,   setModalCelda]   = useState(null)
  const [modalFranja,  setModalFranja]  = useState(null)
  const [modalNovedad, setModalNovedad] = useState(null)
  const [busqueda,     setBusqueda]     = useState('')

  const diasSemana = useMemo(
    () => Array.from({ length: 7 }, (_, i) => toISO(addDays(lunes, i))),
    [lunes]
  )

  // Cargar líneas al montar
  useEffect(() => {
    getLineasActivas().then(ls => {
      setLineas(ls)
      if (ls.length && !linea) setLinea(ls[0])
    }).catch(() => {})
  }, [])

  const cargar = useCallback(async () => {
    if (!linea) return
    setLoading(true)
    try {
      const lunesStr  = toISO(lunes)
      const domingoStr = toISO(addDays(lunes, 6))
      const [f, t, n, r] = await Promise.all([
        getFranjas(linea),
        getTurnosSemanaAsignacion(linea, lunesStr, domingoStr),
        getNovedades({ fechaDesde: lunesStr, fechaHasta: domingoStr, linea }),
        getAgentesLinea(linea),
      ])
      setFranjas(f)
      setTurnosSemana(t)
      setNovedades(n)
      setRoster(r)
    } catch(e) { console.error(e) }
    setLoading(false)
  }, [linea, lunes])

  useEffect(() => { cargar() }, [cargar])

  // ── Datos derivados ───────────────────────────────────────────────────────
  // grilla[`inicio-fin`][fecha] = [turno, ...]
  const grilla = useMemo(() => {
    const g = {}
    for (const f of franjas) {
      const k = `${fmt(f.turno_inicio)}-${fmt(f.turno_fin)}`
      g[k] = {}
      for (const fecha of diasSemana) g[k][fecha] = []
    }
    for (const t of turnosSemana) {
      if (!t.turno_inicio || !t.turno_fin) continue
      const k = `${fmt(t.turno_inicio)}-${fmt(t.turno_fin)}`
      if (g[k]?.[t.fecha]) g[k][t.fecha].push(t)
    }
    return g
  }, [franjas, turnosSemana, diasSemana])

  // agentesEnNovedad[fecha] = Set<nombre>
  const agentesEnNovedad = useMemo(() => {
    const map = {}
    for (const fecha of diasSemana) {
      map[fecha] = new Set(
        novedades
          .filter(n => n.fecha_inicio <= fecha && n.fecha_fin >= fecha)
          .map(n => n.agente)
      )
    }
    return map
  }, [novedades, diasSemana])

  // Analistas sin ninguna franja asignada en toda la semana
  const sinAsignar = useMemo(() => {
    const asignadosSemana = new Set(
      turnosSemana.filter(t => t.turno_inicio).map(t => t.agente)
    )
    return roster.filter(ag => {
      const enNovTodaSemana = diasSemana.every(f => agentesEnNovedad[f]?.has(ag))
      return !asignadosSemana.has(ag) && !enNovTodaSemana
    })
  }, [roster, turnosSemana, diasSemana, agentesEnNovedad])

  // Agentes disponibles para el modal de asignación
  const agentesDisponibles = useMemo(() => {
    if (!modalCelda) return []
    const k = `${fmt(modalCelda.franja.turno_inicio)}-${fmt(modalCelda.franja.turno_fin)}`
    const enCelda = new Set((grilla[k]?.[modalCelda.fecha] || []).map(t => t.agente))
    const enNov   = agentesEnNovedad[modalCelda.fecha] || new Set()
    return roster
      .filter(a => !enCelda.has(a) && !enNov.has(a))
      .filter(a => !busqueda || a.toLowerCase().includes(busqueda.toLowerCase()))
  }, [modalCelda, grilla, agentesEnNovedad, roster, busqueda])

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handleAsignar(agente) {
    if (!modalCelda) return
    setSaving(true)
    try {
      await asignarAFranja({
        agente, linea,
        fecha: modalCelda.fecha,
        turno_inicio: fmt(modalCelda.franja.turno_inicio),
        turno_fin:    fmt(modalCelda.franja.turno_fin),
      })
      await cargar()
      setModalCelda(null); setBusqueda('')
    } catch(e) { alert(e.message) }
    setSaving(false)
  }

  async function handleDesasignar(id) {
    if (!confirm('¿Quitar este analista de la franja?')) return
    try { await desasignarDeFranja(id); await cargar() }
    catch(e) { alert(e.message) }
  }

  async function handleSaveFranja(e) {
    e.preventDefault(); setSaving(true)
    try {
      await saveFranja({ ...modalFranja, linea_atencion: linea })
      await cargar(); setModalFranja(null)
    } catch(e) { alert(e.message) }
    setSaving(false)
  }

  async function handleDeleteFranja(id) {
    if (!confirm('¿Desactivar esta franja?')) return
    try { await deleteFranja(id); await cargar() }
    catch(e) { alert(e.message) }
  }

  async function handleSaveNovedad(e) {
    e.preventDefault(); setSaving(true)
    try {
      await saveNovedad({ ...modalNovedad, creado_por: profile?.full_name })
      await cargar(); setModalNovedad(null)
    } catch(e) { alert(e.message) }
    setSaving(false)
  }

  async function handleDeleteNovedad(id) {
    if (!confirm('¿Eliminar esta novedad?')) return
    try { await deleteNovedad(id); await cargar() }
    catch(e) { alert(e.message) }
  }

  const labelSemana = `${addDays(lunes,0).toLocaleDateString('es-CO',{day:'numeric',month:'short'})} – ${addDays(lunes,6).toLocaleDateString('es-CO',{day:'numeric',month:'short',year:'numeric'})}`

  // ── Render ────────────────────────────────────────────────────────────────
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
              <Link to="/asignacion" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary-50 text-primary-700 transition">
                <LayoutGrid className="w-3.5 h-3.5" /><span className="hidden sm:inline">Asignación</span>
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

      <main className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">

        {/* Controles superiores */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <LayoutGrid className="w-5 h-5 text-primary-600" /> Asignación de turnos
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={linea}
              onChange={e => setLinea(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {lineas.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <div className="flex items-center border border-gray-200 rounded-lg bg-white">
              <button onClick={() => setLunes(addDays(lunes,-7))} className="p-1.5 hover:bg-gray-50 rounded-l-lg">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-medium text-gray-600 px-3 min-w-[150px] text-center">{labelSemana}</span>
              <button onClick={() => setLunes(addDays(lunes,7))} className="p-1.5 hover:bg-gray-50 rounded-r-lg">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {[['asignacion','Asignación'],['franjas','Franjas'],['novedades','Novedades']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                tab === id ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* ── Tab: Asignación ──────────────────────────────────────────────── */}
        {!loading && tab === 'asignacion' && (
          <div className="space-y-4">
            {franjas.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <LayoutGrid className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium mb-1">No hay franjas configuradas para {linea}</p>
                {esPropietario && (
                  <button onClick={() => setTab('franjas')} className="text-primary-600 text-sm underline">
                    Configurar franjas
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                          Franja
                        </th>
                        {diasSemana.map((fecha, i) => {
                          const d = new Date(fecha + 'T00:00:00')
                          const esHoy = fecha === toISO(new Date())
                          return (
                            <th key={fecha} className={`px-3 py-3 text-center border-l border-gray-200 min-w-[120px] ${esHoy ? 'bg-primary-50' : ''}`}>
                              <div className={`text-xs font-semibold ${esHoy ? 'text-primary-600' : 'text-gray-500'}`}>{DIAS_CORTO[i]}</div>
                              <div className={`text-lg font-bold leading-tight ${esHoy ? 'text-primary-700' : 'text-gray-800'}`}>{d.getDate()}</div>
                            </th>
                          )
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {franjas.map(franja => {
                        const k = `${fmt(franja.turno_inicio)}-${fmt(franja.turno_fin)}`
                        const celdas = grilla[k] || {}
                        return (
                          <tr key={franja.id} className="border-b border-gray-100">
                            <td className="px-4 py-3 bg-gray-50 align-top border-r border-gray-100">
                              <div className="font-bold text-gray-800 text-sm whitespace-nowrap">
                                {fmt(franja.turno_inicio)} – {fmt(franja.turno_fin)}
                              </div>
                              <div className="text-xs text-gray-400 mt-0.5">{franja.agentes_requeridos} req.</div>
                            </td>
                            {diasSemana.map(fecha => {
                              const agentes = celdas[fecha] || []
                              const req     = franja.agentes_requeridos
                              const lleno   = agentes.length >= req
                              const parcial = agentes.length > 0 && !lleno
                              const vacio   = agentes.length === 0

                              return (
                                <td key={fecha} className="px-2 py-2 border-l border-gray-100 align-top">
                                  <div className="flex flex-wrap gap-1 min-h-[28px]">
                                    {agentes.map(t => (
                                      <span key={t.id} className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                        {t.agente.split(' ')[0]}
                                        {esAdmin && (
                                          <button onClick={() => handleDesasignar(t.id)}
                                            className="ml-0.5 text-blue-300 hover:text-red-500 transition rounded-full">
                                            <X className="w-3 h-3" />
                                          </button>
                                        )}
                                      </span>
                                    ))}
                                    {esAdmin && (
                                      <button
                                        onClick={() => { setModalCelda({ franja, fecha }); setBusqueda('') }}
                                        title="Agregar analista"
                                        className={`inline-flex items-center justify-center w-5 h-5 rounded-full transition text-xs
                                          ${lleno ? 'bg-green-100 text-green-600 hover:bg-green-200' :
                                            parcial ? 'bg-yellow-100 text-yellow-600 hover:bg-yellow-200' :
                                            'bg-red-100 text-red-500 hover:bg-red-200'}`}>
                                        <Plus className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                  <div className={`text-xs mt-1 font-semibold tabular-nums ${
                                    lleno ? 'text-green-600' : parcial ? 'text-yellow-600' : 'text-red-400'
                                  }`}>
                                    {agentes.length}/{req}
                                  </div>
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Panel sin asignar */}
                {sinAsignar.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                      <span className="text-sm font-semibold text-amber-800">
                        {sinAsignar.length} analista{sinAsignar.length !== 1 ? 's' : ''} sin franja asignada esta semana
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {sinAsignar.map(ag => (
                        <span key={ag} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
                          <User className="w-3 h-3" /> {ag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Tab: Franjas ─────────────────────────────────────────────────── */}
        {!loading && tab === 'franjas' && (
          <div className="space-y-4">
            {esPropietario && (
              <div className="flex justify-end">
                <button
                  onClick={() => setModalFranja({ turno_inicio:'', turno_fin:'', agentes_requeridos: 1 })}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition">
                  <Plus className="w-4 h-4" /> Nueva franja
                </button>
              </div>
            )}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              {franjas.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  No hay franjas configuradas para {linea}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Inicio</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Fin</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Agentes requeridos</th>
                      {esPropietario && <th className="px-4 py-3 w-32"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {franjas.map(f => (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-semibold text-gray-800">{fmt(f.turno_inicio)}</td>
                        <td className="px-4 py-3 font-semibold text-gray-800">{fmt(f.turno_fin)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary-100 text-primary-800">
                            {f.agentes_requeridos} agentes
                          </span>
                        </td>
                        {esPropietario && (
                          <td className="px-4 py-3">
                            <div className="flex gap-2 justify-end">
                              <button onClick={() => setModalFranja(f)}
                                className="text-xs text-gray-500 hover:text-primary-600 px-2.5 py-1 rounded-lg border border-gray-200 hover:border-primary-300 transition">
                                Editar
                              </button>
                              <button onClick={() => handleDeleteFranja(f.id)}
                                className="text-xs text-red-500 hover:text-red-700 px-2.5 py-1 rounded-lg border border-red-200 hover:border-red-300 transition">
                                Eliminar
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Novedades ───────────────────────────────────────────────── */}
        {!loading && tab === 'novedades' && (
          <div className="space-y-4">
            {esAdmin && (
              <div className="flex justify-end">
                <button
                  onClick={() => setModalNovedad({ agente:'', linea_atencion: linea, fecha_inicio:'', fecha_fin:'', tipo:'VACACION', observacion:'' })}
                  className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition">
                  <Plus className="w-4 h-4" /> Nueva novedad
                </button>
              </div>
            )}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              {novedades.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  No hay novedades para esta semana en {linea}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Analista</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Tipo</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Desde</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Hasta</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Observación</th>
                      {esAdmin && <th className="px-4 py-3 w-24"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {novedades.map(n => (
                      <tr key={n.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-800">{n.agente}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${COLOR_NOVEDAD[n.tipo] || 'bg-gray-100 text-gray-600'}`}>
                            {n.tipo}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 tabular-nums">{n.fecha_inicio}</td>
                        <td className="px-4 py-3 text-gray-600 tabular-nums">{n.fecha_fin}</td>
                        <td className="px-4 py-3 text-gray-500">{n.observacion || '—'}</td>
                        {esAdmin && (
                          <td className="px-4 py-3">
                            <button onClick={() => handleDeleteNovedad(n.id)}
                              className="text-xs text-red-500 hover:text-red-700 px-2.5 py-1 rounded-lg border border-red-200 hover:border-red-300 transition">
                              Eliminar
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

      </main>

      {/* ── Modal: Agregar analista a celda ──────────────────────────────── */}
      {modalCelda && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && (setModalCelda(null), setBusqueda(''))}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-start justify-between mb-1">
              <h3 className="font-semibold text-gray-800">
                Asignar a {fmt(modalCelda.franja.turno_inicio)}–{fmt(modalCelda.franja.turno_fin)}
              </h3>
              <button onClick={() => { setModalCelda(null); setBusqueda('') }} className="text-gray-400 hover:text-gray-600 ml-2">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {new Date(modalCelda.fecha + 'T00:00:00').toLocaleDateString('es-CO',{ weekday:'long', day:'numeric', month:'long' })}
            </p>
            <input
              type="text"
              placeholder="Buscar analista…"
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <div className="max-h-56 overflow-y-auto divide-y divide-gray-50 rounded-lg border border-gray-100">
              {agentesDisponibles.length === 0 ? (
                <p className="text-center py-6 text-sm text-gray-400">No hay analistas disponibles</p>
              ) : (
                agentesDisponibles.map(ag => (
                  <button key={ag} onClick={() => handleAsignar(ag)} disabled={saving}
                    className="w-full text-left px-3 py-2.5 text-sm hover:bg-primary-50 hover:text-primary-700 transition disabled:opacity-50 first:rounded-t-lg last:rounded-b-lg">
                    {ag}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Editar / nueva franja ─────────────────────────────────── */}
      {modalFranja && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-gray-800">{modalFranja.id ? 'Editar franja' : 'Nueva franja'}</h3>
              <button onClick={() => setModalFranja(null)}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
            </div>
            <form onSubmit={handleSaveFranja} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hora inicio</label>
                  <input type="time" required
                    value={fmt(modalFranja.turno_inicio)}
                    onChange={e => setModalFranja(p => ({ ...p, turno_inicio: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hora fin</label>
                  <input type="time" required
                    value={fmt(modalFranja.turno_fin)}
                    onChange={e => setModalFranja(p => ({ ...p, turno_fin: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Agentes requeridos</label>
                <input type="number" min="1" required
                  value={modalFranja.agentes_requeridos || 1}
                  onChange={e => setModalFranja(p => ({ ...p, agentes_requeridos: parseInt(e.target.value) || 1 }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setModalFranja(null)}
                  className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">
                  Cancelar
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition">
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Nueva novedad ─────────────────────────────────────────── */}
      {modalNovedad && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-semibold text-gray-800">Nueva novedad</h3>
              <button onClick={() => setModalNovedad(null)}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
            </div>
            <form onSubmit={handleSaveNovedad} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Analista</label>
                <select required
                  value={modalNovedad.agente}
                  onChange={e => setModalNovedad(p => ({ ...p, agente: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">Seleccionar analista…</option>
                  {roster.map(ag => <option key={ag} value={ag}>{ag}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
                <select
                  value={modalNovedad.tipo}
                  onChange={e => setModalNovedad(p => ({ ...p, tipo: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  {TIPOS_NOVEDAD.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Desde</label>
                  <input type="date" required
                    value={modalNovedad.fecha_inicio}
                    onChange={e => setModalNovedad(p => ({ ...p, fecha_inicio: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Hasta</label>
                  <input type="date" required
                    value={modalNovedad.fecha_fin}
                    onChange={e => setModalNovedad(p => ({ ...p, fecha_fin: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Observación (opcional)</label>
                <input type="text"
                  value={modalNovedad.observacion}
                  onChange={e => setModalNovedad(p => ({ ...p, observacion: e.target.value }))}
                  placeholder="Ej: vacaciones aprobadas semana 28"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setModalNovedad(null)}
                  className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">
                  Cancelar
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition">
                  {saving ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
