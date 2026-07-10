import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useTranslation } from 'react-i18next'
import {
  getTurnosSemana, getMisTurnos, getTurnosFuturos, getTurnosMesAnalista,
  crearSolicitudCambio, getSolicitudesCambio,
  responderSolicitudCambio, cancelarSolicitudCambio,
  getSolicitudesPendientesSupervisor, aprobarCambio,
  rechazarCambioSupervisor, aplicarCambioEnSheet, aplicarCambioEnSupabase,
  intercambiarTurnosDirecto, importarTurnosDesdeSheet, getCambiosAprobadosRecientes,
  autoAplicarCambioAceptado, forzarAplicarCambioAceptado, getVipConfig, setVipConfig as saveVipConfig,
  autoDetectarNombreTurno, guardarNombreTurnoEnPerfil,
  reportarHorasExtra, getMisHorasExtra,
  actualizarTurnoProgramado, crearTurnoProgramado,
  sincronizarTurnoEnSheet,
  iniciarPausa, terminarPausa, getPausaActiva, getPausasHoy, getPausasHoyTodos,
  registrarSlackIdAutomatico,
} from '../lib/vip'
import {
  Calendar, ArrowLeftRight, CheckCircle, XCircle, AlertTriangle,
  RefreshCw, Settings, X, ChevronLeft, ChevronRight, User, Search,
  Home, Building2, Heart, Download, Moon, PlusCircle, Clock, Pencil,
  Coffee, Play, Square,
} from 'lucide-react'

const SCRIPT_URL_KEY    = 'vip_script_url'
const SCRIPT_SECRET_KEY = 'vip_script_secret'
const NOMBRE_TURNO_KEY  = 'vip_nombre_turno'
const SHEET_IMPORT_KEY  = 'vip_sheet_import_url'

const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
const DIAS  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']

function getLunes(offset = 0) {
  const hoy = new Date()
  const dow = hoy.getDay()
  const lunes = new Date(hoy)
  lunes.setDate(hoy.getDate() + (dow === 0 ? -6 : 1 - dow) + offset * 7)
  lunes.setHours(0, 0, 0, 0)
  const domingo = new Date(lunes)
  domingo.setDate(lunes.getDate() + 6)
  return { lunes, domingo }
}

function toISO(d) { return d.toISOString().slice(0, 10) }
function formatH(h) { return h ? h.slice(0, 5) : '—' }
function localDateISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
function esHoy(f) { return f === localDateISO() }

function labelSemana(lunes, domingo) {
  return `${lunes.getDate()} ${MESES[lunes.getMonth()]} – ${domingo.getDate()} ${MESES[domingo.getMonth()]} ${domingo.getFullYear()}`
}

function formatFecha(f) {
  if (!f) return '—'
  const d = new Date(f + 'T12:00:00')
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`
}

// Genera array de fechas entre inicio y fin (ISO strings)
function rangoFechas(inicio, fin) {
  const dates = []
  const d = new Date(inicio + 'T12:00:00')
  const end = new Date(fin + 'T12:00:00')
  while (d <= end) {
    dates.push(toISO(d))
    d.setDate(d.getDate() + 1)
  }
  return dates
}

const BADGE = {
  pendiente:'bg-yellow-100 text-yellow-700', aceptado:'bg-blue-100 text-blue-700',
  rechazado:'bg-red-100 text-red-700', aprobado:'bg-green-100 text-green-700',
  rechazado_supervisor:'bg-red-100 text-red-700', cancelado:'bg-gray-100 text-gray-500',
}

function getLabelEstado(estado, t) {
  return ({
    pendiente: t('turnos.pendiente'),
    aceptado: t('turnos.aceptado'),
    rechazado: t('turnos.rechazado'),
    aprobado: t('turnos.aprobado'),
    rechazado_supervisor: t('turnos.rechazado_supervisor'),
    cancelado: t('turnos.cancelado'),
  })[estado] ?? estado
}

// Badge de modalidad (columna email del sheet)
function ModalidadBadge({ email }) {
  if (!email) return null
  const low = email.toLowerCase()
  if (low.includes('remot') || low.includes('teletrabajo') || low.includes('casa'))
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded-full shrink-0">
        <Home className="w-3 h-3" /> {email}
      </span>
    )
  if (low.includes('famil'))
    return (
      <span className="inline-flex items-center gap-1 text-xs text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded-full shrink-0">
        <Heart className="w-3 h-3" /> {email}
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded-full shrink-0">
      <Building2 className="w-3 h-3" /> {email}
    </span>
  )
}

// ── Validación básica ─────────────────────────────────────────────────────────
function esDescanso(turno) { return !turno?.turno_inicio }

function turnoInicioMs(turno) {
  if (turno.turno_inicio) return new Date(`${turno.fecha}T${turno.turno_inicio}`).getTime()
  return new Date(turno.fecha + 'T00:00:00').getTime()
}
function turnoEnCurso(turno) {
  const ahora = Date.now()
  if (!turno.turno_inicio) return false
  const ini = new Date(`${turno.fecha}T${turno.turno_inicio}`).getTime()
  const fin = turno.turno_fin ? new Date(`${turno.fecha}T${turno.turno_fin}`).getTime() : Infinity
  return ahora >= ini && ahora <= fin
}

function validar8h(tSol, tRec, t) {
  const err = []
  const ahora = Date.now()
  const dSol = turnoInicioMs(tSol)
  const dRec = turnoInicioMs(tRec)
  if (tSol.linea_atencion && tRec.linea_atencion && tSol.linea_atencion !== tRec.linea_atencion)
    err.push(t('turnos.errMismaLinea', { linea: tSol.linea_atencion }))
  if (turnoEnCurso(tSol)) err.push('Tu turno ya está en curso, no es posible solicitar un cambio.')
  else if (dSol <= ahora) err.push(t('turnos.errTurnoPasado'))
  if (turnoEnCurso(tRec)) err.push('El turno del otro analista ya está en curso.')
  else if (dRec <= ahora) err.push(t('turnos.errTurnoOtroPasado'))
  // Si alguno es día de descanso, no aplica la restricción de 8h de anticipación
  if (!esDescanso(tSol) && !esDescanso(tRec)) {
    const i1 = new Date(`${tSol.fecha}T${tSol.turno_inicio}`).getTime()
    const i2 = new Date(`${tRec.fecha}T${tRec.turno_inicio}`).getTime()
    const h = (Math.min(i1, i2) - ahora) / 3600000
    if (h < 8) err.push(t('turnos.errAnticipacion', { h: h.toFixed(1) }))
  }
  return err
}

function validarCambio(tSol, tRec, turnosSol, turnosRec, t) {
  const errores = validar8h(tSol, tRec, t)
  const advertencias = []
  const check12h = (turnos, quitar, agregar, quien) => {
    const lista = [...turnos.filter(t => !(t.fecha === quitar.fecha && t.turno_inicio === quitar.turno_inicio)), agregar]
      .filter(t => t.turno_inicio && t.turno_fin)
      .sort((a, b) => new Date(`${a.fecha}T${a.turno_inicio}`) - new Date(`${b.fecha}T${b.turno_inicio}`))
    for (let i = 0; i < lista.length - 1; i++) {
      const gap = (new Date(`${lista[i+1].fecha}T${lista[i+1].turno_inicio}`) - new Date(`${lista[i].fecha}T${lista[i].turno_fin}`)) / 3600000
      if (gap >= 0 && gap < 12)
        advertencias.push(t('turnos.errDescanso', { quien, h: gap.toFixed(1) }))
    }
  }
  check12h(turnosSol, tSol, tRec, t('turnos.tu'))
  check12h(turnosRec, tRec, tSol, tRec.agente || '')
  return { errores, advertencias }
}

// ── Modal: cambio desde MIS TURNOS ────────────────────────────────────────────
function SolicitarModal({ miTurno, turnosPropios, todosLosTurnos, solicitudesActivas, nombreEfectivo, onClose, onCreado }) {
  const { t } = useTranslation()
  const [elegido, setElegido] = useState(null)
  const [motivo, setMotivo]   = useState('')
  const [errores, setErrores]       = useState([])
  const [advertencias, setAdv]      = useState([])
  const [ignorarAdv, setIgnorarAdv] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [filtro, setFiltro]         = useState('')

  const mombre = nombreEfectivo.toLowerCase()

  const disponibles = todosLosTurnos.filter(t => {
    if (t.agente?.toLowerCase() === mombre) return false
    if (t.fecha !== miTurno.fecha) return false  // solo mismo día que el turno a ceder
    // Excluir si ya inició o está en curso
    if (t.turno_inicio && new Date(`${t.fecha}T${t.turno_inicio}`) <= Date.now()) return false
    // Excluir si no tiene turno_inicio Y la fecha ya pasó (descansos en fechas pasadas)
    if (!t.turno_inicio && new Date(t.fecha + 'T23:59:59') <= Date.now()) return false
    if (miTurno.linea_atencion && t.linea_atencion && t.linea_atencion !== miTurno.linea_atencion) return false
    const bloq = solicitudesActivas.some(s =>
      ['pendiente','aceptado'].includes(s.estado) && (
        (s.turno_rec_fecha === t.fecha && s.receptor_nombre?.toLowerCase() === t.agente?.toLowerCase()) ||
        (s.turno_sol_fecha === t.fecha && s.solicitante_nombre?.toLowerCase() === t.agente?.toLowerCase())
      ))
    return !bloq && (!filtro || t.agente?.toLowerCase().includes(filtro.toLowerCase()))
  })

  const porAnalista = disponibles.reduce((a, t) => { if (!a[t.agente]) a[t.agente] = []; a[t.agente].push(t); return a }, {})

  function elegir(turno) {
    setElegido(turno)
    setIgnorarAdv(false)
    const turnosRec = todosLosTurnos.filter(x => x.agente?.toLowerCase() === turno.agente?.toLowerCase())
    const { errores: e, advertencias: a } = validarCambio(miTurno, turno, turnosPropios, turnosRec, t)
    setErrores(e)
    setAdv(a)
  }

  async function submit() {
    setSaving(true)
    try {
      await crearSolicitudCambio({ solicitanteNombre: nombreEfectivo, receptorNombre: elegido.agente, turnoSol: miTurno, turnoRec: elegido, motivo: motivo.trim() || null })
      onCreado()
    } catch (e) { setErrores([e.message]) }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900">{t('turnos.solicitarCambio')}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t('turnos.tuTurnoCeder')}: <strong>{formatFecha(miTurno.fecha)}</strong> {formatH(miTurno.turno_inicio)}–{formatH(miTurno.turno_fin)}</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {errores.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 space-y-1">
              {errores.map((e, i) => <p key={i} className="text-sm text-red-700 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0"/>{e}</p>)}
            </div>
          )}
          {advertencias.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-2">
              {advertencias.map((a, i) => (
                <p key={i} className="text-sm text-amber-800 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500"/>{a}
                </p>
              ))}
              {!ignorarAdv
                ? <button onClick={() => setIgnorarAdv(true)}
                    className="mt-1 text-xs font-semibold text-amber-700 underline hover:text-amber-900 transition">
                    Ignorar advertencia y continuar de todos modos
                  </button>
                : <p className="text-xs text-amber-600 font-medium">✓ Advertencia ignorada — puedes enviar la solicitud</p>
              }
            </div>
          )}
          <input value={filtro} onChange={e => setFiltro(e.target.value)} placeholder={t('turnos.buscarAnalista')}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
          {Object.keys(porAnalista).length === 0
            ? <p className="text-sm text-gray-400 text-center py-8">{t('turnos.noTurnosDisponibles')}</p>
            : Object.entries(porAnalista).map(([ag, ts]) => (
              <div key={ag}>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{ag}</p>
                <div className="space-y-2">
                  {ts.map(turno => (
                    <div key={turno.id ?? `${turno.agente}-${turno.fecha}`} onClick={() => elegir(turno)}
                      className={`border rounded-xl p-3 cursor-pointer transition ${elegido?.fecha===turno.fecha&&elegido?.agente===turno.agente?'border-primary-500 bg-primary-50':'border-gray-200 hover:border-primary-300 hover:bg-gray-50'}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{formatFecha(turno.fecha)}</span>
                        {esDescanso(turno)
                          ? <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Descanso</span>
                          : <span className="text-xs text-gray-500">{formatH(turno.turno_inicio)} – {formatH(turno.turno_fin)}</span>
                        }
                      </div>
                      {turno.linea_atencion && <p className="text-xs text-gray-400 mt-0.5">{turno.linea_atencion}{turno.tipo_turno ? ` · ${turno.tipo_turno}` : ''}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))
          }
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">{t('turnos.motivo')} <span className="text-gray-400 font-normal">{t('common.opcional')}</span></label>
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={2} placeholder={t('turnos.porQueCambio')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"/>
          </div>
        </div>
        <div className="px-6 py-4 border-t flex gap-3 shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">{t('common.cancelar')}</button>
          <button onClick={submit} disabled={!elegido || saving || errores.length > 0 || (advertencias.length > 0 && !ignorarAdv)}
            className="flex-1 px-4 py-2 bg-primary-700 text-white rounded-lg text-sm font-medium hover:bg-primary-800 disabled:opacity-50">
            {saving ? t('common.enviando') : t('turnos.enviarSolicitud')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal: cambio desde MALLA ─────────────────────────────────────────────────
function SolicitarDesdeMallaModal({ turnoObjetivo, solicitudesActivas, nombreEfectivo, onClose, onCreado }) {
  const { t } = useTranslation()
  const [misFuturos, setMisFuturos]   = useState([])
  const [elegido, setElegido]         = useState(null)
  const [motivo, setMotivo]           = useState('')
  const [errores, setErrores]         = useState([])
  const [saving, setSaving]           = useState(false)
  const [loadingT, setLoadingT]       = useState(true)

  useEffect(() => {
    getMisTurnos(nombreEfectivo).then(d => {
      const futuros = d.filter(turno =>
        turno.fecha === turnoObjetivo.fecha &&  // solo el mismo día
        !turnoEnCurso(turno) &&                 // excluir si ya está en curso
        !(turnoObjetivo.linea_atencion && turno.linea_atencion && turno.linea_atencion !== turnoObjetivo.linea_atencion)
      )
      setMisFuturos(futuros)
      setLoadingT(false)
    })
  }, [nombreEfectivo])

  function elegir(turno) {
    setElegido(turno)
    setErrores(validar8h(turno, turnoObjetivo, t))
  }

  async function submit() {
    setSaving(true)
    try {
      await crearSolicitudCambio({
        solicitanteNombre: nombreEfectivo,
        receptorNombre:    turnoObjetivo.agente,
        turnoSol:          elegido,
        turnoRec:          turnoObjetivo,
        motivo:            motivo.trim() || null,
      })
      onCreado()
    } catch (e) { setErrores([e.message]) }
    setSaving(false)
  }

  const bloqueado = solicitudesActivas.some(s =>
    ['pendiente','aceptado'].includes(s.estado) && (
      s.turno_rec_fecha === turnoObjetivo.fecha && s.receptor_nombre?.toLowerCase() === turnoObjetivo.agente?.toLowerCase()
    ))

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900">{t('turnos.solicitarCambio')}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('turnos.quieresElTurno')} <strong>{turnoObjetivo.agente}</strong>: {formatFecha(turnoObjetivo.fecha)} {formatH(turnoObjetivo.turno_inicio)}–{formatH(turnoObjetivo.turno_fin)}
              {turnoObjetivo.linea_atencion && <span className="text-gray-400"> · {turnoObjetivo.linea_atencion}</span>}
            </p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {bloqueado && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <p className="text-sm text-amber-700">{t('turnos.turnoActivoAviso')}</p>
            </div>
          )}
          {errores.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 space-y-1">
              {errores.map((e, i) => <p key={i} className="text-sm text-red-700 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0"/>{e}</p>)}
            </div>
          )}
          <p className="text-sm font-medium text-gray-700">{t('turnos.turnoQueOfreces')}</p>
          {loadingT ? <p className="text-sm text-gray-400 text-center py-6">{t('turnos.cargandoTurnos')}</p>
            : misFuturos.length === 0
            ? <p className="text-sm text-gray-400 text-center py-6">
                {t('turnos.noTurnosDisponibles')}
              </p>
            : (
              <div className="space-y-2">
                {misFuturos.map(turno => (
                  <div key={turno.id ?? `${turno.fecha}-${turno.turno_inicio}`} onClick={() => elegir(turno)}
                    className={`border rounded-xl p-3 cursor-pointer transition ${elegido?.fecha===turno.fecha&&elegido?.turno_inicio===turno.turno_inicio?'border-primary-500 bg-primary-50':'border-gray-200 hover:border-primary-300 hover:bg-gray-50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{formatFecha(turno.fecha)}</span>
                      <span className="text-xs text-gray-500">{formatH(turno.turno_inicio)} – {formatH(turno.turno_fin)}</span>
                    </div>
                    {turno.linea_atencion && <p className="text-xs text-gray-400 mt-0.5">{turno.linea_atencion}{turno.tipo_turno ? ` · ${turno.tipo_turno}` : ''}</p>}
                  </div>
                ))}
              </div>
            )}
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">{t('turnos.motivo')} <span className="text-gray-400 font-normal">{t('common.opcional')}</span></label>
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={2} placeholder={t('turnos.porQueQuieres')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"/>
          </div>
        </div>
        <div className="px-6 py-4 border-t flex gap-3 shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">{t('common.cancelar')}</button>
          <button onClick={submit} disabled={!elegido||saving||errores.length>0||bloqueado}
            className="flex-1 px-4 py-2 bg-primary-700 text-white rounded-lg text-sm font-medium hover:bg-primary-800 disabled:opacity-50">
            {saving ? t('common.enviando') : t('turnos.enviarSolicitud')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal: cambiar día de descanso ────────────────────────────────────────────
function CambiarDescansoModal({ miDescanso, turnosSemana, solicitudesActivas, nombreEfectivo, onClose, onCreado }) {
  const [elegido, setElegido] = useState(null)
  const [saving, setSaving]   = useState(false)

  const nombre = nombreEfectivo.toLowerCase()

  // Derivar línea de atención desde turnos no-descanso (los descansos suelen tener linea null)
  const lineaDeAnalista = {}
  for (const t of turnosSemana) {
    if (!esDescanso(t) && t.agente && t.linea_atencion)
      lineaDeAnalista[t.agente.toLowerCase()] = t.linea_atencion
  }
  const miLinea = lineaDeAnalista[nombre] ?? miDescanso.linea_atencion

  const otrosDescansos = turnosSemana.filter(t => {
    if (!esDescanso(t)) return false
    if (t.agente?.toLowerCase() === nombre) return false
    if (t.fecha === miDescanso.fecha) return false
    if (new Date(t.fecha + 'T23:59:59') <= Date.now()) return false
    if (miLinea) {
      const suLinea = lineaDeAnalista[t.agente?.toLowerCase()] ?? t.linea_atencion
      if (suLinea && suLinea !== miLinea) return false
    }
    const bloq = solicitudesActivas.some(s =>
      ['pendiente','aceptado'].includes(s.estado) && (
        (s.turno_rec_fecha === t.fecha && s.receptor_nombre?.toLowerCase() === t.agente?.toLowerCase()) ||
        (s.turno_sol_fecha === t.fecha && s.solicitante_nombre?.toLowerCase() === t.agente?.toLowerCase())
      ))
    return !bloq
  })

  const porAnalista = {}
  for (const t of otrosDescansos) if (!porAnalista[t.agente]) porAnalista[t.agente] = t

  async function submit() {
    if (!elegido) return
    setSaving(true)
    try {
      await crearSolicitudCambio({
        solicitanteNombre: nombreEfectivo,
        receptorNombre:    elegido.agente,
        turnoSol:          miDescanso,
        turnoRec:          elegido,
        motivo:            null,
      })
      onCreado()
    } catch (e) { alert(e.message) }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <Moon className="w-4 h-4 text-emerald-600"/> Cambiar día de descanso
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Tu descanso: <strong>{formatFecha(miDescanso.fecha)}</strong></p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-600" /></button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-3">
          {Object.keys(porAnalista).length === 0
            ? <p className="text-sm text-gray-400 text-center py-8">No hay analistas disponibles para cambiar descanso esta semana.</p>
            : (
              <>
                <p className="text-sm text-gray-600">¿Con quién quieres cambiar tu día de descanso?</p>
                <div className="space-y-2">
                  {Object.entries(porAnalista).map(([ag, descanso]) => (
                    <div key={ag} onClick={() => setElegido(elegido?.agente === ag ? null : descanso)}
                      className={`border rounded-xl p-3 cursor-pointer transition ${elegido?.agente === ag ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-emerald-300 hover:bg-gray-50'}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{ag}</span>
                        <span className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Descansa el {formatFecha(descanso.fecha)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                {elegido && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800 space-y-1">
                    <p className="font-medium mb-1">Si {elegido.agente} acepta:</p>
                    <p>→ Tú descansarás el <strong>{formatFecha(elegido.fecha)}</strong></p>
                    <p>→ {elegido.agente} descansará el <strong>{formatFecha(miDescanso.fecha)}</strong></p>
                  </div>
                )}
              </>
            )
          }
        </div>
        <div className="px-6 py-4 border-t flex gap-3 shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Cancelar</button>
          <button onClick={submit} disabled={!elegido || saving}
            className="flex-1 px-4 py-2 bg-emerald-700 text-white rounded-lg text-sm font-medium hover:bg-emerald-800 disabled:opacity-50">
            {saving ? 'Enviando…' : 'Enviar solicitud'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal: editar turno programado ───────────────────────────────────────────
function EditarTurnoModal({ turno, lineasDisponibles, onClose, onGuardado, scriptUrl, scriptSecret }) {
  const isNuevo = !turno.id
  const [descanso,  setDescanso]  = useState(!turno.turno_inicio)
  const [inicio,    setInicio]    = useState(turno.turno_inicio?.slice(0,5) || '')
  const [fin,       setFin]       = useState(turno.turno_fin?.slice(0,5) || '')
  const [brkIni,    setBrkIni]    = useState(turno.break_inicio?.slice(0,5) || '')
  const [brkFin,    setBrkFin]    = useState(turno.break_fin?.slice(0,5) || '')
  const [lchIni,    setLchIni]    = useState(turno.lunch_inicio?.slice(0,5) || '')
  const [lchFin,    setLchFin]    = useState(turno.lunch_fin?.slice(0,5) || '')
  const [linea,     setLinea]     = useState(turno.linea_atencion || '')
  const [tipoT,     setTipoT]     = useState(turno.tipo_turno || '')
  const [novedad,   setNovedad]   = useState(turno.novedad || '')
  const [agente,    setAgente]    = useState(turno.agente || '')
  const [saving,    setSaving]    = useState(false)
  const [err,       setErr]       = useState(null)

  const puedeGuardar = isNuevo
    ? agente.trim() && turno.fecha && (descanso || (inicio && fin))
    : descanso || (inicio && fin)

  async function guardar() {
    setSaving(true); setErr(null)
    const campos = {
      turno_inicio:  descanso ? null : inicio  || null,
      turno_fin:     descanso ? null : fin     || null,
      break_inicio:  descanso ? null : brkIni  || null,
      break_fin:     descanso ? null : brkFin  || null,
      lunch_inicio:  descanso ? null : lchIni  || null,
      lunch_fin:     descanso ? null : lchFin  || null,
      linea_atencion: linea   || null,
      tipo_turno:    tipoT    || null,
      novedad:       novedad  || null,
    }
    try {
      const agenteNombre = isNuevo ? agente.trim() : turno.agente
      if (isNuevo) {
        await crearTurnoProgramado({ ...campos, agente: agenteNombre, fecha: turno.fecha })
      } else {
        await actualizarTurnoProgramado(turno.id, campos)
      }
      if (scriptUrl?.trim() && scriptSecret?.trim()) {
        const dt = (h) => h ? `${turno.fecha} ${h}:00` : null
        const camposSheet = {
          ...campos,
          turno_inicio: descanso ? null : dt(inicio),
          turno_fin:    descanso ? null : dt(fin),
          break_inicio: descanso ? null : dt(brkIni),
          break_fin:    descanso ? null : dt(brkFin),
          lunch_inicio: descanso ? null : dt(lchIni),
          lunch_fin:    descanso ? null : dt(lchFin),
        }
        sincronizarTurnoEnSheet(scriptUrl.trim(), scriptSecret.trim(), agenteNombre, turno.fecha, camposSheet).catch(() => {})
      }
      onGuardado()
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  const TimeInput = ({ label, value, onChange, optional }) => (
    <div>
      <label className="text-xs font-medium text-gray-700 block mb-1">
        {label} {optional && <span className="text-gray-400 font-normal">(opcional)</span>}
      </label>
      <input type="time" value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[92vh]">
        <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <Pencil className="w-4 h-4 text-primary-600"/>
              {isNuevo ? 'Nuevo turno' : 'Editar turno'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {isNuevo
                ? formatFecha(turno.fecha)
                : <><strong>{turno.agente}</strong> · {formatFecha(turno.fecha)}</>
              }
            </p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-600"/></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
          {/* Analista (solo si es nuevo) */}
          {isNuevo && (
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Analista <span className="text-red-500">*</span></label>
              <input type="text" value={agente} onChange={e => setAgente(e.target.value)}
                placeholder="Nombre exacto del analista"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
            </div>
          )}

          {/* Tipo de turno */}
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1.5">Tipo</label>
            <div className="flex gap-2">
              <button onClick={() => setDescanso(false)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${!descanso ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                Turno de trabajo
              </button>
              <button onClick={() => setDescanso(true)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${descanso ? 'bg-emerald-600 text-white border-emerald-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                🌙 Día descanso
              </button>
            </div>
          </div>

          {!descanso && (
            <>
              {/* Horario principal */}
              <div className="grid grid-cols-2 gap-3">
                <TimeInput label="Entrada *" value={inicio} onChange={setInicio}/>
                <TimeInput label="Salida *" value={fin} onChange={setFin}/>
              </div>

              {/* Break */}
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Break ☕</p>
                <div className="grid grid-cols-2 gap-3">
                  <TimeInput label="Inicio" value={brkIni} onChange={setBrkIni} optional/>
                  <TimeInput label="Fin" value={brkFin} onChange={setBrkFin} optional/>
                </div>
              </div>

              {/* Lunch */}
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Almuerzo 🍽</p>
                <div className="grid grid-cols-2 gap-3">
                  <TimeInput label="Inicio" value={lchIni} onChange={setLchIni} optional/>
                  <TimeInput label="Fin" value={lchFin} onChange={setLchFin} optional/>
                </div>
              </div>
            </>
          )}

          {/* Línea de atención */}
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">
              Línea de atención <span className="text-gray-400 font-normal">(opcional)</span>
            </label>
            <input type="text" value={linea} onChange={e => setLinea(e.target.value)}
              list="lineas-list" placeholder="Ej: Especializado"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
            <datalist id="lineas-list">
              {lineasDisponibles.map(l => <option key={l} value={l}/>)}
            </datalist>
          </div>

          {/* Novedad */}
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">
              Novedad <span className="text-gray-400 font-normal">(opcional)</span>
            </label>
            <input type="text" value={novedad} onChange={e => setNovedad(e.target.value)}
              placeholder="Ej: Incapacidad, Vacaciones, Permiso…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        </div>

        <div className="px-6 py-4 border-t flex gap-3 shrink-0">
          <button onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
            Cancelar
          </button>
          <button onClick={guardar} disabled={!puedeGuardar || saving}
            className="flex-1 px-4 py-2 bg-primary-700 text-white rounded-lg text-sm font-medium hover:bg-primary-800 disabled:opacity-50 flex items-center justify-center gap-2">
            <Pencil className="w-3.5 h-3.5"/>
            {saving ? 'Guardando…' : isNuevo ? 'Crear turno' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal: reportar horas extra ──────────────────────────────────────────────
function ReportarHEModal({ nombreEfectivo, onClose, onCreado }) {
  const hoyStr = localDateISO()
  const [fecha,      setFecha]   = useState(hoyStr)
  const [horas,      setHoras]   = useState(1)
  const [comentario, setCom]     = useState('')
  const [aprobadoPor,setApob]    = useState('')
  const [saving,     setSaving]  = useState(false)
  const [err,        setErr]     = useState(null)

  const necesitaAprobacion = horas > 2
  const puedeEnviar = comentario.trim() && (!necesitaAprobacion || aprobadoPor.trim())

  async function submit() {
    setSaving(true); setErr(null)
    try {
      await reportarHorasExtra({ agente: nombreEfectivo, fecha, horasExtra: horas, comentario: comentario.trim(), aprobadoPor: aprobadoPor.trim() || null })
      onCreado()
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b">
          <div>
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-orange-500"/> Reportar horas extra
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">Horas trabajadas fuera de tu turno programado</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400 hover:text-gray-600"/></button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">Fecha</label>
            <input type="date" value={fecha} max={hoyStr} onChange={e => setFecha(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"/>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">Horas adicionales</label>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="number" value={horas} min={0.5} max={8} step={0.5}
                onChange={e => setHoras(Math.max(0.5, Math.min(8, +e.target.value || 0.5)))}
                className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 tabular-nums"/>
              <span className="text-sm text-gray-500">hora{horas !== 1 ? 's' : ''}</span>
              {[0.5, 1, 1.5, 2].map(h => (
                <button key={h} onClick={() => setHoras(h)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border transition ${horas === h ? 'bg-orange-500 text-white border-orange-500' : 'border-gray-300 text-gray-600 hover:border-orange-300'}`}>
                  {h}h
                </button>
              ))}
            </div>
          </div>

          {necesitaAprobacion && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5"/>
              <p className="text-xs text-amber-800">Más de 2 horas requiere autorización expresa. Indica quién aprobó estas horas adicionales.</p>
            </div>
          )}

          {necesitaAprobacion && (
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Aprobado por <span className="text-red-500">*</span></label>
              <input type="text" value={aprobadoPor} onChange={e => setApob(e.target.value)}
                placeholder="Nombre del supervisor que autorizó"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"/>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">
              Comentario <span className="text-red-500">*</span>
              <span className="text-gray-400 font-normal ml-1">— ¿qué trabajo adicional realizaste?</span>
            </label>
            <textarea value={comentario} onChange={e => setCom(e.target.value)} rows={3}
              placeholder="Ej: Cubrimiento turno, soporte urgente cliente VIP, gestión incidencia crítica…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-500"/>
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        </div>

        <div className="px-6 py-4 border-t flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Cancelar</button>
          <button onClick={submit} disabled={!puedeEnviar || saving}
            className="flex-1 px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-50">
            {saving ? 'Guardando…' : 'Reportar horas extra'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Calendario semanal estilo time-grid ──────────────────────────────────────
const CAL_PX_H  = 52
const CAL_H_INI = 6    // eje: 06:00
const CAL_H_FIN = 26   // eje: 26:00 = 02:00 del día siguiente
const CAL_ALTO  = (CAL_H_FIN - CAL_H_INI) * CAL_PX_H

const CAL_HORAS = Array.from({ length: CAL_H_FIN - CAL_H_INI }, (_, i) => {
  const h = (CAL_H_INI + i) % 24
  return `${String(h).padStart(2, '0')}:00`
})

// Paleta de colores por línea de atención
const PALETA_CAL = [
  { bg: '#171717', light: '#d4d4d4' },  // black
  { bg: '#404040', light: '#e5e5e5' },  // dark gray
  { bg: '#525252', light: '#e5e5e5' },  // gray
  { bg: '#262626', light: '#d4d4d4' },  // near-black
  { bg: '#737373', light: '#f5f5f5' },  // mid gray
  { bg: '#1a1a1a', light: '#d4d4d4' },  // charcoal
  { bg: '#3d3d3d', light: '#e5e5e5' },  // slate gray
]
function calLineaColor(linea) {
  if (!linea) return PALETA_CAL[0]
  let h = 0
  for (const c of linea) h = ((h * 31) + c.charCodeAt(0)) & 0xffff
  return PALETA_CAL[h % PALETA_CAL.length]
}

function calDec(s) {
  if (!s) return null
  const [h, m] = s.slice(0, 5).split(':').map(Number)
  return h + m / 60
}
function calTop(h) {
  if (h < CAL_H_INI) h += 24
  return (h - CAL_H_INI) * CAL_PX_H
}
function calPx(ini, fin) {
  let i = calDec(ini), f = calDec(fin)
  if (!i || !f) return 0
  if (f <= i) f += 24
  return (f - i) * CAL_PX_H
}

// ── Widget de pausas/breaks ──────────────────────────────────────────────────
function PausaWidget({ turnoHoy, nombreEfectivo }) {
  const [pausaActiva, setPausaActiva] = useState(null)
  const [pausasHoy,   setPausasHoy]   = useState([])
  const [elapsed,     setElapsed]     = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [iniciando,   setIniciando]   = useState(null)

  function toMin(t) {
    if (!t) return null
    const [h, m] = String(t).split(':').map(Number)
    return h * 60 + m
  }

  async function cargar() {
    try {
      const [activa, hoy] = await Promise.all([
        getPausaActiva(nombreEfectivo),
        getPausasHoy(nombreEfectivo),
      ])
      setPausaActiva(activa)
      setPausasHoy(hoy)
    } catch {}
  }

  useEffect(() => { if (nombreEfectivo) cargar() }, [nombreEfectivo])

  // Contador en vivo mientras hay pausa activa
  useEffect(() => {
    if (!pausaActiva) { setElapsed(0); return }
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(pausaActiva.inicio_real).getTime()) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [pausaActiva])

  async function handleIniciar(tipo) {
    setIniciando(tipo)
    try {
      const iniMin = tipo === 'break' ? toMin(turnoHoy?.break_inicio) : toMin(turnoHoy?.lunch_inicio)
      const finMin = tipo === 'break' ? toMin(turnoHoy?.break_fin)   : toMin(turnoHoy?.lunch_fin)
      const durProg = (iniMin && finMin) ? finMin - iniMin : null
      await iniciarPausa(nombreEfectivo, tipo, durProg)
      await cargar()
    } catch (e) { alert(e.message) }
    setIniciando(null)
  }

  async function handleTerminar() {
    if (!pausaActiva) return
    setLoading(true)
    try {
      await terminarPausa(pausaActiva.id)
      await cargar()
    } catch (e) { alert(e.message) }
    setLoading(false)
  }

  function fmtSec(s) {
    const m = Math.floor(s / 60), ss = s % 60
    return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
  }
  function fmtHm(iso) {
    return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
  }

  const pausada = Boolean(pausaActiva)
  const progSeg = pausaActiva?.duracion_prog ? pausaActiva.duracion_prog * 60 : null
  const sobrepasado = progSeg && elapsed > progSeg

  const pausasTerminadas = pausasHoy.filter(p => p.fin_real)

  return (
    <div className={`rounded-xl border p-4 ${pausada ? (sobrepasado ? 'border-red-300 bg-red-50' : 'border-orange-300 bg-orange-50') : 'border-gray-200 bg-white'}`}>
      {/* Cabecera */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
          <Coffee className="w-3.5 h-3.5" /> Pausas
        </p>
        {turnoHoy && (
          <div className="flex flex-wrap gap-3 text-xs text-gray-400">
            {turnoHoy.break_inicio  && <span>Pausa: {formatH(turnoHoy.break_inicio)}–{formatH(turnoHoy.break_fin)}</span>}
            {turnoHoy.lunch_inicio  && <span>Almuerzo: {formatH(turnoHoy.lunch_inicio)}–{formatH(turnoHoy.lunch_fin)}</span>}
          </div>
        )}
      </div>

      {pausada ? (
        /* Pausa activa */
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-sm font-semibold text-orange-800">
              {pausaActiva.tipo === 'break' ? '☕ En pausa' : '🍽️ En almuerzo'}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-2xl font-mono font-bold tabular-nums ${sobrepasado ? 'text-red-600 animate-pulse' : 'text-gray-800'}`}>
                {fmtSec(elapsed)}
              </span>
              {pausaActiva.duracion_prog && (
                <span className="text-xs text-gray-500">
                  / {pausaActiva.duracion_prog} min programados
                  {sobrepasado && ` (+${Math.floor((elapsed - progSeg) / 60)} min extra)`}
                </span>
              )}
            </div>
            {progSeg && (
              <div className="mt-2 w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${sobrepasado ? 'bg-red-500' : 'bg-orange-400'}`}
                  style={{ width: `${Math.min((elapsed / progSeg) * 100, 100)}%` }}
                />
              </div>
            )}
          </div>
          <button onClick={handleTerminar} disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-xl disabled:opacity-50 transition shrink-0">
            <Square className="w-4 h-4" /> Terminar
          </button>
        </div>
      ) : (
        /* Sin pausa activa */
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => handleIniciar('break')} disabled={iniciando != null}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-orange-50 hover:bg-orange-100 text-orange-700 border border-orange-200 rounded-xl disabled:opacity-50 transition">
            {iniciando === 'break' ? <RefreshCw className="w-4 h-4 animate-spin"/> : <Play className="w-4 h-4" />}
            Iniciar pausa
          </button>
          <button onClick={() => handleIniciar('almuerzo')} disabled={iniciando != null}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 rounded-xl disabled:opacity-50 transition">
            {iniciando === 'almuerzo' ? <RefreshCw className="w-4 h-4 animate-spin"/> : <Play className="w-4 h-4" />}
            Iniciar almuerzo
          </button>
        </div>
      )}

      {/* Historial del día */}
      {pausasTerminadas.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-200 space-y-1.5">
          <p className="text-xs text-gray-400 font-medium">Hoy</p>
          {pausasTerminadas.map(p => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span>{p.tipo === 'break' ? '☕' : '🍽️'}</span>
              <span className="text-gray-500">{fmtHm(p.inicio_real)} – {fmtHm(p.fin_real)}</span>
              <span className="font-semibold text-gray-700">{p.duracion_real} min</span>
              {p.excedido_min != null && (
                <span className={`px-1.5 py-0.5 rounded font-semibold ${p.excedido_min > 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                  {p.excedido_min > 0 ? `+${p.excedido_min}m` : `${p.excedido_min}m`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CalendarioSemana({ diasSemana, misTurnos, solicitudes, nombre, hoyStr, onCambiar, onDescanso }) {
  const nowDec = (() => { const n = new Date(); return n.getHours() + n.getMinutes() / 60 })()
  const nowTop = calTop(nowDec)

  const pf = {}
  for (const t of misTurnos) pf[t.fecha] = t

  const totalH = misTurnos.reduce((acc, t) => {
    if (esDescanso(t)) return acc
    const i = calDec(t.turno_inicio), f = calDec(t.turno_fin)
    if (!i || !f) return acc
    const diff = f <= i ? f + 24 - i : f - i
    return acc + diff
  }, 0)
  const diaDescanso = misTurnos.find(t => esDescanso(t))

  return (
    <div className="space-y-3">
      {/* Pills resumen */}
      <div className="flex flex-wrap gap-2">
        {totalH > 0 && (
          <span className="text-xs bg-primary-100 text-primary-700 font-semibold px-2.5 py-1 rounded-full">
            {totalH.toFixed(1)}h semana
          </span>
        )}
        {diaDescanso && (
          <span className="text-xs bg-emerald-100 text-emerald-700 font-semibold px-2.5 py-1 rounded-full">
            🌙 Descanso: {formatFecha(diaDescanso.fecha)}
          </span>
        )}
        {misTurnos.length === 0 && (
          <span className="text-xs bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">Sin turnos esta semana</span>
        )}
      </div>

      {/* Grid */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {/* Header días */}
        <div className="flex border-b border-gray-200 bg-gray-50">
          <div className="w-10 shrink-0 border-r border-gray-200"/>
          {diasSemana.map(fecha => {
            const d   = new Date(fecha + 'T12:00:00')
            const esH = fecha === hoyStr
            const tieneTurno = !!pf[fecha]
            return (
              <div key={fecha}
                className={`flex-1 min-w-0 text-center py-2 border-r border-gray-200 last:border-r-0 ${esH ? 'bg-primary-50' : ''}`}>
                <p className={`text-[9px] font-bold uppercase tracking-wider ${esH ? 'text-primary-500' : 'text-gray-400'}`}>
                  {DIAS[d.getDay()].slice(0, 3)}
                </p>
                <p className={`text-base font-bold leading-tight ${esH ? 'text-primary-700' : tieneTurno ? 'text-gray-700' : 'text-gray-300'}`}>
                  {d.getDate()}
                </p>
              </div>
            )
          })}
        </div>

        {/* Body con scroll */}
        <div className="overflow-y-auto" style={{ maxHeight: 680 }}>
          <div className="flex" style={{ height: CAL_ALTO }}>
            {/* Eje horas */}
            <div className="w-10 shrink-0 relative border-r border-gray-200">
              {CAL_HORAS.map((h, i) => (
                <div key={h} className="absolute right-1 text-[9px] text-gray-300 -translate-y-2"
                  style={{ top: i * CAL_PX_H }}>
                  {h}
                </div>
              ))}
            </div>

            {/* Columnas días */}
            {diasSemana.map(fecha => {
              const turno = pf[fecha]
              const esH   = fecha === hoyStr
              const esD   = turno ? esDescanso(turno) : false

              const tieneActiva = solicitudes.some(s =>
                ['pendiente','aceptado'].includes(s.estado) && (
                  (s.solicitante_nombre?.toLowerCase() === nombre && s.turno_sol_fecha === fecha) ||
                  (s.receptor_nombre?.toLowerCase() === nombre && s.turno_rec_fecha === fecha)
                ))
              const esFuturo = turno
                ? new Date(`${turno.fecha}T${turno.turno_inicio || '23:59'}`) > new Date()
                : false

              const tTop = turno && !esD ? calTop(calDec(turno.turno_inicio)) : 0
              const tH   = turno && !esD ? calPx(turno.turno_inicio, turno.turno_fin) : 0

              return (
                <div key={fecha}
                  className={`flex-1 min-w-0 relative border-r border-gray-200 last:border-r-0 ${esH ? 'bg-primary-50/20' : ''}`}>
                  {/* Líneas por hora */}
                  {CAL_HORAS.map((_, i) => (
                    <div key={i} className="absolute left-0 right-0 border-t border-gray-100" style={{ top: i * CAL_PX_H }}/>
                  ))}

                  {/* Línea "ahora" */}
                  {esH && nowTop >= 0 && nowTop <= CAL_ALTO && (
                    <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: nowTop }}>
                      <div className="border-t-2 border-red-400 border-dashed w-full"/>
                      <div className="absolute -left-0.5 -top-1 w-2 h-2 rounded-full bg-red-400"/>
                    </div>
                  )}

                  {/* Descanso */}
                  {turno && esD && (
                    <div className="absolute inset-x-0.5 top-1 bottom-1 rounded border-2 border-dashed border-emerald-400 bg-emerald-50 flex flex-col items-center justify-center gap-0.5 p-1">
                      <span className="text-sm">🌙</span>
                      <span className="text-[9px] font-semibold text-emerald-700 text-center">Descanso</span>
                      {!tieneActiva && esFuturo && (
                        <button onClick={() => onDescanso(turno)}
                          className="text-[8px] bg-emerald-200 hover:bg-emerald-300 text-emerald-800 px-1 py-0.5 rounded transition mt-0.5">
                          Cambiar →
                        </button>
                      )}
                    </div>
                  )}

                  {/* Turno trabajo */}
                  {turno && !esD && tH > 0 && (() => {
                    const color = calLineaColor(turno.linea_atencion)
                    return (
                      <div className="absolute inset-x-0.5 rounded shadow-sm overflow-hidden z-10"
                        style={{ top: tTop, height: Math.max(tH, 28), backgroundColor: color.bg }}>

                        {/* Banda break */}
                        {turno.break_inicio && turno.break_fin && (() => {
                          const bt = calTop(calDec(turno.break_inicio)) - tTop
                          const bh = Math.max(calPx(turno.break_inicio, turno.break_fin), 14)
                          return (
                            <div className="absolute left-0 right-0 flex items-center gap-0.5 overflow-hidden"
                              style={{ top: bt, height: bh, backgroundColor: 'rgba(0,0,0,0.32)', borderTop: '1px solid rgba(255,255,255,0.25)', borderBottom: '1px solid rgba(255,255,255,0.25)' }}>
                              <span className="text-[9px] leading-none px-0.5 text-white/90">☕</span>
                              <span className="text-[8px] text-white/70">{formatH(turno.break_inicio)}</span>
                            </div>
                          )
                        })()}

                        {/* Banda lunch */}
                        {turno.lunch_inicio && turno.lunch_fin && (() => {
                          const lt = calTop(calDec(turno.lunch_inicio)) - tTop
                          const lh = Math.max(calPx(turno.lunch_inicio, turno.lunch_fin), 14)
                          return (
                            <div className="absolute left-0 right-0 flex items-center gap-0.5 overflow-hidden"
                              style={{ top: lt, height: lh, backgroundColor: 'rgba(0,0,0,0.32)', borderTop: '1px solid rgba(255,255,255,0.25)', borderBottom: '1px solid rgba(255,255,255,0.25)' }}>
                              <span className="text-[9px] leading-none px-0.5 text-white/90">🍽</span>
                              {lh >= 18 && <span className="text-[8px] text-white/70">{formatH(turno.lunch_inicio)}</span>}
                            </div>
                          )
                        })()}

                        {/* Contenido */}
                        <div className="relative z-10 p-1">
                          <p className="text-[9px] font-bold text-white leading-tight">
                            {formatH(turno.turno_inicio)}–{formatH(turno.turno_fin)}
                          </p>
                          {turno.linea_atencion && (
                            <p className="text-[8px] truncate font-medium" style={{ color: color.light }}>{turno.linea_atencion}</p>
                          )}
                          {!tieneActiva && esFuturo && tH >= CAL_PX_H && (
                            <button onClick={() => onCambiar(turno)}
                              className="text-[8px] text-white px-1 py-0.5 rounded mt-0.5 transition block w-full text-left"
                              style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
                              onMouseEnter={e => e.target.style.backgroundColor = 'rgba(255,255,255,0.3)'}
                              onMouseLeave={e => e.target.style.backgroundColor = 'rgba(255,255,255,0.2)'}>
                              ⇄ Cambiar
                            </button>
                          )}
                          {tieneActiva && (
                            <span className="text-[8px] bg-amber-300 text-amber-900 px-1 py-0.5 rounded block mt-0.5">Pendiente</span>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function offsetParaFecha(dateStr) {
  const target = new Date(dateStr + 'T12:00:00')
  const { lunes } = getLunes(0)
  return Math.floor((target.getTime() - lunes.getTime()) / (7 * 24 * 3600000))
}

// ── Calendario mensual estilo iOS ─────────────────────────────────────────────
const MESES_LARGO = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

function CalendarioMes({ nombre, onNavegar }) {
  const [mesOffset, setMesOffset] = useState(0)
  const [turnos, setTurnos] = useState([])
  const [cargandoMes, setCargandoMes] = useState(true)

  const hoy = new Date()
  const mesD = new Date(hoy.getFullYear(), hoy.getMonth() + mesOffset, 1)
  const hoyStr = localDateISO()

  useEffect(() => {
    if (!nombre) return
    setCargandoMes(true)
    const y = mesD.getFullYear()
    const m = mesD.getMonth()
    const inicio = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const last = new Date(y, m + 1, 0)
    const fin = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
    getTurnosMesAnalista(nombre, inicio, fin)
      .then(data => { setTurnos(data); setCargandoMes(false) })
      .catch(() => setCargandoMes(false))
  }, [nombre, mesOffset])

  const porFecha = {}
  for (const t of turnos) porFecha[t.fecha] = t

  const daysInMonth = new Date(mesD.getFullYear(), mesD.getMonth() + 1, 0).getDate()
  const firstDow = mesD.getDay()
  const startPad = firstDow === 0 ? 6 : firstDow - 1

  const cells = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const fecha = `${mesD.getFullYear()}-${String(mesD.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ dia: d, fecha, turno: porFecha[fecha] || null })
  }
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shrink-0 w-full lg:w-[420px]">
      {/* Cabecera */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
        <button onClick={() => setMesOffset(o => o - 1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-semibold text-gray-800">
          {MESES_LARGO[mesD.getMonth()]} {mesD.getFullYear()}
        </span>
        <button onClick={() => setMesOffset(o => o + 1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Encabezado días */}
      <div className="grid grid-cols-7 border-b border-gray-100">
        {['L','M','X','J','V','S','D'].map((d, i) => (
          <div key={d} className={`text-center py-1.5 text-[10px] font-semibold select-none ${i >= 5 ? 'text-gray-300' : 'text-gray-400'}`}>
            {d}
          </div>
        ))}
      </div>

      {/* Cuadrícula */}
      {cargandoMes ? (
        <div className="grid grid-cols-7">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className="min-h-[88px] border-r border-b border-gray-100 animate-pulse bg-gray-50/60" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            const isWeekend = i % 7 >= 5
            if (!cell) {
              return (
                <div key={`pad-${i}`}
                  className={`min-h-[88px] border-r border-b border-gray-100 ${isWeekend ? 'bg-gray-50/50' : ''}`}
                />
              )
            }

            const isHoy    = cell.fecha === hoyStr
            const turno    = cell.turno
            const isDesc   = turno && !turno.turno_inicio
            const hasTurno = turno && turno.turno_inicio
            const color    = hasTurno ? calLineaColor(turno.linea_atencion) : null

            return (
              <button
                key={cell.fecha}
                onClick={() => onNavegar(cell.fecha)}
                className={`min-h-[88px] px-1 pt-1 pb-1.5 flex flex-col items-center gap-1 border-r border-b border-gray-100 transition ${
                  isWeekend ? 'bg-gray-50/40' : ''
                } ${isHoy ? 'bg-gray-100/60' : ''} hover:bg-black/[0.03]`}
              >
                {/* Número del día */}
                <span className={`text-[11px] font-bold w-5 h-5 flex items-center justify-center rounded-full leading-none shrink-0 ${
                  isHoy        ? 'bg-gray-800 text-white' :
                  isWeekend    ? 'text-gray-300' :
                                 'text-gray-600'
                }`}>
                  {cell.dia}
                </span>

                {/* Evento descanso */}
                {isDesc && (
                  <div className="w-full rounded-[4px] px-1 py-1 border-l-[2px] border-emerald-400 bg-emerald-50">
                    <p className="text-[8px] font-semibold text-emerald-700 leading-none">🌙 Desc.</p>
                  </div>
                )}

                {/* Evento turno — hora inicio y fin en dos líneas */}
                {hasTurno && (
                  <div
                    className="w-full rounded-[4px] px-1 py-1"
                    style={{
                      borderLeft: `2px solid ${color.bg}`,
                      backgroundColor: color.bg + '18',
                    }}
                  >
                    <p className="text-[9px] font-bold leading-none" style={{ color: color.bg }}>
                      {turno.turno_inicio?.slice(0, 5)}
                    </p>
                    <p className="text-[8px] leading-none mt-0.5" style={{ color: color.bg + 'bb' }}>
                      {turno.turno_fin?.slice(0, 5)}
                    </p>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Estado vacío */}
      {!cargandoMes && turnos.length === 0 && (
        <div className="px-3 py-2.5 border-t border-gray-100 flex items-center gap-2">
          <span className="text-[10px] text-gray-400 italic">Sin turnos programados este mes</span>
        </div>
      )}
    </div>
  )
}

// ── Navegador de semana ───────────────────────────────────────────────────────
function NavSemana({ offset, onChange }) {
  const { t } = useTranslation()
  const { lunes, domingo } = getLunes(offset)
  return (
    <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-2.5">
      <button onClick={() => onChange(offset - 1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition">
        <ChevronLeft className="w-5 h-5"/>
      </button>
      <div className="text-center">
        <p className="text-sm font-semibold text-gray-800">{labelSemana(lunes, domingo)}</p>
        {offset === 0
          ? <p className="text-xs text-primary-600">{t('turnos.semanaActual')}</p>
          : <button onClick={() => onChange(0)} className="text-xs text-primary-600 underline hover:text-primary-800">{t('turnos.volverHoy')}</button>
        }
      </div>
      <button onClick={() => onChange(offset + 1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition">
        <ChevronRight className="w-5 h-5"/>
      </button>
    </div>
  )
}

// ── Navegador de día ─────────────────────────────────────────────────────────
function NavDia({ fecha, onNavegar }) {
  const hoyStr = localDateISO()
  const d = new Date(fecha + 'T12:00:00')
  const esHoy = fecha === hoyStr
  const label = `${['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][d.getDay()]}, ${d.getDate()} de ${MESES_LARGO[d.getMonth()]} ${d.getFullYear()}`
  function mover(delta) {
    const nd = new Date(d); nd.setDate(d.getDate() + delta)
    onNavegar(toISO(nd))
  }
  return (
    <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-2.5">
      <button onClick={() => mover(-1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition">
        <ChevronLeft className="w-5 h-5"/>
      </button>
      <div className="text-center">
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        {esHoy
          ? <p className="text-xs text-gray-500">Hoy</p>
          : <button onClick={() => onNavegar(hoyStr)} className="text-xs text-gray-500 underline hover:text-gray-800">Ir a hoy</button>
        }
      </div>
      <button onClick={() => mover(1)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition">
        <ChevronRight className="w-5 h-5"/>
      </button>
    </div>
  )
}

// ── Vista timeline (Gantt) por día ────────────────────────────────────────────
function TimelineDay({ turnos, esAdmin, onEditar, hoy: esHoyFlag }) {
  const [ahora, setAhora] = useState(() => { const n = new Date(); return n.getHours() + n.getMinutes() / 60 })
  const [soloActivos, setSoloActivos] = useState(false)
  useEffect(() => {
    if (!esHoyFlag) return
    const id = setInterval(() => {
      const n = new Date(); setAhora(n.getHours() + n.getMinutes() / 60)
    }, 60_000)
    return () => clearInterval(id)
  }, [esHoyFlag])

  // Parsea HH:MM, YYYY-MM-DD HH:MM:SS o YYYY-MM-DDTHH:MM:SS a horas decimales
  function toHDec(s) {
    if (!s) return null
    let time = String(s)
    if (time.includes('T')) time = time.split('T')[1]
    else if (time.includes(' ')) time = time.split(' ')[1]
    const [h, m] = time.split(':').map(Number)
    if (isNaN(h)) return null
    return h + (m || 0) / 60
  }

  const activos   = turnos.filter(t => !esDescanso(t))
  const descansos = turnos.filter(t => esDescanso(t))

  if (activos.length === 0 && descansos.length === 0)
    return <p className="px-4 py-3 text-xs text-gray-300">Sin turnos</p>

  // getEstado sin depender del rango (para poder filtrar ANTES de calcular el rango)
  function getEstado(t) {
    if (!esHoyFlag) return null
    const ini  = toHDec(t.turno_inicio)
    const fin  = toHDec(t.turno_fin)
    const bIni = toHDec(t.break_inicio); const bFin = toHDec(t.break_fin)
    const lIni = toHDec(t.lunch_inicio); const lFin = toHDec(t.lunch_fin)
    if (ini === null) return null
    const ov  = ini > 12 && fin !== null && fin < 6
    const adj = h => (ov && h !== null && h < 6) ? h + 24 : h
    const now = ov && ahora < 6 ? ahora + 24 : ahora
    if (now < ini) return 'por_iniciar'
    if (adj(fin) !== null && now > adj(fin)) return 'finalizado'
    if (bIni !== null && bFin !== null && now >= adj(bIni) && now <= adj(bFin)) return 'en_pausa'
    if (lIni !== null && lFin !== null && now >= adj(lIni) && now <= adj(lFin)) return 'en_almuerzo'
    return 'en_turno'
  }

  const ESTADO_STYLE = {
    en_turno:    { cls: 'bg-green-100 text-green-700', label: 'En turno' },
    en_pausa:    { cls: 'bg-amber-100 text-amber-700', label: 'En pausa' },
    en_almuerzo: { cls: 'bg-teal-100 text-teal-700',   label: 'Almuerzo' },
    por_iniciar: { cls: 'bg-gray-100 text-gray-400',   label: 'Por iniciar' },
    finalizado:  { cls: 'bg-gray-100 text-gray-400',   label: 'Finalizado' },
  }

  const ESTADOS_ACTIVOS = new Set(['en_turno', 'en_pausa', 'en_almuerzo'])
  const sortedAll = [...activos].sort((a, b) => (toHDec(a.turno_inicio) ?? 99) - (toHDec(b.turno_inicio) ?? 99))
  const sorted = (esHoyFlag && soloActivos)
    ? sortedAll.filter(t => ESTADOS_ACTIVOS.has(getEstado(t)))
    : sortedAll

  // Rango temporal basado en los agentes VISIBLES (sorted), no en todos
  const rangeSource = sorted.length > 0 ? sorted : activos
  const starts = rangeSource.map(t => toHDec(t.turno_inicio)).filter(v => v !== null)
  const ends   = rangeSource.map(t => toHDec(t.turno_fin)).filter(v => v !== null).map(h => h < 6 ? h + 24 : h)
  const rangeStart = starts.length ? Math.max(0, Math.floor(Math.min(...starts)) - 1) : 6
  const rangeEnd   = ends.length   ? Math.min(27, Math.ceil(Math.max(...ends))   + 1) : 23
  const span       = Math.max(rangeEnd - rangeStart, 1)

  const ticks = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => rangeStart + i)

  function adjH(h) { return (h !== null && h < 6 && rangeStart >= 12) ? h + 24 : h }
  function pctLeft(h) {
    const adj = adjH(h)
    return `${Math.max(0, Math.min(100, ((adj - rangeStart) / span) * 100))}%`
  }
  function pctWidth(from, to) {
    if (from === null || to === null) return '0%'
    const f = adjH(from); const t = adjH(to)
    return `${Math.max(0, ((t - f) / span) * 100)}%`
  }

  // Línea "ahora"
  const nowAdj = adjH(ahora)
  const nowPct = esHoyFlag && nowAdj >= rangeStart && nowAdj <= rangeEnd
    ? `${((nowAdj - rangeStart) / span) * 100}%`
    : null

  // Resumen de estados (solo hoy)
  let cntTurno = 0, cntPausa = 0, cntAlmuerzo = 0
  if (esHoyFlag) {
    for (const t of sorted) {
      const e = getEstado(t)
      if (e === 'en_turno') cntTurno++
      else if (e === 'en_pausa') cntPausa++
      else if (e === 'en_almuerzo') cntAlmuerzo++
    }
  }

  return (
    <div className="px-4 pb-4 pt-3 overflow-x-auto">
      {/* Resumen en tiempo real (solo hoy) */}
      {esHoyFlag && (
        <div className="pl-28 mb-2 flex items-center justify-between gap-3 text-[10px]">
          <div className="flex items-center gap-3">
            <span className="text-gray-400">Ahora:</span>
            {cntTurno > 0 && <span className="flex items-center gap-1 bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium"><span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse"/>{cntTurno} en turno</span>}
            {cntPausa > 0 && <span className="flex items-center gap-1 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block"/>{cntPausa} en pausa</span>}
            {cntAlmuerzo > 0 && <span className="flex items-center gap-1 bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full font-medium"><span className="w-1.5 h-1.5 rounded-full bg-teal-400 inline-block"/>{cntAlmuerzo} en almuerzo</span>}
          </div>
          <button
            onClick={() => setSoloActivos(v => !v)}
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border transition ${soloActivos ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-gray-500 border-gray-300 hover:border-primary-400 hover:text-primary-600'}`}>
            {soloActivos ? '✓ Solo en turno' : 'Solo en turno'}
          </button>
        </div>
      )}

      <div style={{ minWidth: '500px' }}>
        {/* Eje de horas — flex para que % use el mismo ancho que las barras */}
        <div className="flex items-end h-5 mb-1">
          <div className="w-28 shrink-0" />
          <div className="flex-1 relative overflow-visible">
            {ticks.map(h => (
              <div key={h} className="absolute bottom-0 text-[9px] text-gray-400 -translate-x-1/2 select-none"
                style={{ left: `${((h - rangeStart) / span) * 100}%` }}>
                {String(h > 23 ? h - 24 : h).padStart(2,'0')}h
              </div>
            ))}
            {nowPct && (
              <div className="absolute bottom-0 -translate-x-1/2 text-[8px] text-red-500 font-semibold select-none bg-white px-0.5 rounded z-10"
                style={{ left: nowPct }}>
                {String(new Date().getHours()).padStart(2,'0')}:{String(new Date().getMinutes()).padStart(2,'0')}
              </div>
            )}
          </div>
        </div>

        {/* Filas — grilla y barras en el mismo flex-1 para alineación perfecta */}
        <div className="space-y-1">
          {sorted.map(t => {
            const ini  = toHDec(t.turno_inicio)
            const fin  = toHDec(t.turno_fin)
            const bIni = toHDec(t.break_inicio)
            const bFin = toHDec(t.break_fin)
            const lIni = toHDec(t.lunch_inicio)
            const lFin = toHDec(t.lunch_fin)
            const estado = getEstado(t)
            const est = estado ? ESTADO_STYLE[estado] : null
            return (
              <div key={t.id ?? t.agente} className="flex items-center h-10 group">
                <div className="w-28 shrink-0 pr-2 text-right">
                  <p className="text-xs text-gray-700 font-medium truncate leading-tight">
                    {t.agente?.split(' ').slice(0, 2).join(' ')}
                  </p>
                  {est ? (
                    <span className={`inline-block text-[8px] font-semibold px-1.5 py-px rounded-full leading-none mt-px ${est.cls}`}>
                      {est.label}
                    </span>
                  ) : (
                    <p className="text-[9px] text-gray-400 tabular-nums">
                      {formatH(t.turno_inicio)}–{formatH(t.turno_fin)}
                    </p>
                  )}
                </div>
                <div className="flex-1 relative h-6">
                  {/* Grilla vertical — mismo contenedor que las barras */}
                  {ticks.map(h => (
                    <div key={h} className="absolute top-0 h-full border-l border-gray-100 pointer-events-none"
                      style={{ left: `${((h - rangeStart) / span) * 100}%` }} />
                  ))}
                  {/* Línea "ahora" */}
                  {nowPct && (
                    <div className="absolute top-0 h-full w-px bg-red-400/70 pointer-events-none z-10"
                      style={{ left: nowPct }} />
                  )}
                  {/* Barra turno */}
                  {ini !== null && (
                    <div className={`absolute top-0 h-full ${fin === null ? 'rounded-l' : 'rounded'} ${estado === 'en_turno' ? 'bg-primary-500' : 'bg-primary-500/60'}`}
                      style={{ left: pctLeft(ini), width: pctWidth(ini, fin ?? rangeEnd) }} />
                  )}
                  {/* Pausa */}
                  {bIni !== null && bFin !== null && (
                    <div className={`absolute top-0 h-full rounded ${estado === 'en_pausa' ? 'bg-amber-500' : 'bg-amber-400/80'}`}
                      style={{ left: pctLeft(bIni), width: pctWidth(bIni, bFin) }} />
                  )}
                  {/* Almuerzo */}
                  {lIni !== null && lFin !== null && (
                    <div className={`absolute top-0 h-full rounded ${estado === 'en_almuerzo' ? 'bg-teal-500' : 'bg-emerald-400/80'}`}
                      style={{ left: pctLeft(lIni), width: pctWidth(lIni, lFin) }} />
                  )}
                </div>
                {esAdmin && (
                  <button onClick={() => onEditar(t)}
                    title="Editar turno"
                    className="ml-1.5 opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-primary-600 shrink-0 transition">
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )
          })}

          {descansos.map(t => (
            <div key={t.id ?? t.agente} className="flex items-center h-7 opacity-50">
              <div className="w-28 shrink-0 pr-2 text-right text-xs text-gray-400 truncate">
                {t.agente?.split(' ').slice(0, 2).join(' ')}
              </div>
              <span className="text-xs text-emerald-500 italic">Descanso</span>
            </div>
          ))}
        </div>

        {/* Leyenda */}
        <div className="pl-28 mt-3 flex items-center gap-4 text-[10px] text-gray-400">
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-primary-500/75 rounded inline-block"/>Turno</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-amber-400 rounded inline-block"/>Pausa</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 bg-emerald-400 rounded inline-block"/>Almuerzo</span>
          {esHoyFlag && <span className="flex items-center gap-1"><span className="w-px h-3 bg-red-400 inline-block"/>Hora actual</span>}
        </div>
      </div>
    </div>
  )
}

// ── Monitor de breaks del día ─────────────────────────────────────────────────
function BreaksMonitor() {
  function getNow()    { const n = new Date(); return n.getHours() + n.getMinutes() / 60 }
  function getNowStr() { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}` }

  const [now, setNow]         = useState(getNow)
  const [nowStr, setNowStr]   = useState(getNowStr)
  const [tick, setTick]       = useState(0)
  const [turnos, setTurnos]   = useState([])
  const [pausas, setPausas]   = useState([])
  const [loading, setLoading] = useState(true)
  const [filtroLinea, setFL]  = useState('')
  const [vistaTab, setVT]     = useState('horario')  // 'horario' | 'reales'

  useEffect(() => {
    cargar()
    const id = setInterval(() => {
      setNow(getNow()); setNowStr(getNowStr()); setTick(t => t + 1)
    }, 10_000)
    return () => clearInterval(id)
  }, [])

  async function cargar() {
    setLoading(true)
    const hoy = localDateISO()
    const [data, pData] = await Promise.all([
      getTurnosSemana(hoy, hoy),
      getPausasHoyTodos(),
    ])
    setTurnos(data ?? [])
    setPausas(pData ?? [])
    setLoading(false)
  }

  function toH(s) {
    if (!s) return null
    let time = String(s)
    if (time.includes('T')) time = time.split('T')[1]
    else if (time.includes(' ')) time = time.split(' ')[1]
    const [h, m] = time.split(':').map(Number)
    if (isNaN(h)) return null
    return h + (m || 0) / 60
  }
  function fmtT(s) {
    if (!s) return '—'
    let time = String(s)
    if (time.includes('T')) time = time.split('T')[1]
    else if (time.includes(' ')) time = time.split(' ')[1]
    return time.slice(0, 5)
  }
  function fmtHM(iso) {
    return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
  }
  function fmtMin(min) {
    if (min < 1) return 'ahora mismo'
    if (min < 60) return `en ${Math.round(min)} min`
    const h = Math.floor(min / 60); const m = Math.round(min % 60)
    return m > 0 ? `en ${h}h ${m}min` : `en ${h}h`
  }

  // ── Datos de horario programado ──────────────────────────────────────────────
  const activos = turnos.filter(t => !esDescanso(t))
  const lineas  = [...new Set(activos.map(t => t.linea_atencion).filter(Boolean))].sort()
  const base    = filtroLinea ? activos.filter(t => t.linea_atencion === filtroLinea) : activos

  const eventos = []
  const _seen = new Set()
  for (const t of base) {
    const bIni = toH(t.break_inicio); const bFin = toH(t.break_fin)
    const lIni = toH(t.lunch_inicio); const lFin = toH(t.lunch_fin)
    if (bIni !== null && bFin !== null) {
      const k = `${t.agente}-b-${bIni}-${bFin}`
      if (!_seen.has(k)) { _seen.add(k); eventos.push({ tipo: 'pausa', agente: t.agente, linea: t.linea_atencion, ini: bIni, fin: bFin, iniStr: fmtT(t.break_inicio), finStr: fmtT(t.break_fin), key: k }) }
    }
    if (lIni !== null && lFin !== null) {
      const k = `${t.agente}-l-${lIni}-${lFin}`
      if (!_seen.has(k)) { _seen.add(k); eventos.push({ tipo: 'almuerzo', agente: t.agente, linea: t.linea_atencion, ini: lIni, fin: lFin, iniStr: fmtT(t.lunch_inicio), finStr: fmtT(t.lunch_fin), key: k }) }
    }
  }

  const enCurso  = eventos.filter(e => now >= e.ini && now <= e.fin).sort((a,b) => a.fin - b.fin)
  const proximos = eventos.filter(e => now < e.ini && (e.ini - now) * 60 <= 90).sort((a,b) => a.ini - b.ini)
  const masTarde = eventos.filter(e => now < e.ini && (e.ini - now) * 60 > 90).sort((a,b) => a.ini - b.ini)

  // ── Datos de pausas reales ───────────────────────────────────────────────────
  const activas    = pausas.filter(p => !p.fin_real)
  const terminadas = pausas.filter(p => p.fin_real)

  // Resumen por analista (terminadas)
  const resumenMap = {}
  for (const p of terminadas) {
    if (!resumenMap[p.agente]) resumenMap[p.agente] = { agente: p.agente, totalMin: 0, excedidoMin: 0, pausas: 0, excesos: 0 }
    const r = resumenMap[p.agente]
    r.totalMin    += p.duracion_real ?? 0
    r.excedidoMin += Math.max(0, p.excedido_min ?? 0)
    r.pausas++
    if ((p.excedido_min ?? 0) > 0) r.excesos++
  }
  const resumen = Object.values(resumenMap).sort((a, b) => b.excedidoMin - a.excedidoMin)

  // ── Exportar CSV ─────────────────────────────────────────────────────────────
  function exportarCSV() {
    const hoy = localDateISO()
    const rows = [['Analista','Tipo','Inicio','Fin','Duración (min)','Programado (min)','Excedido (min)']]
    for (const p of terminadas) {
      rows.push([
        p.agente, p.tipo,
        fmtHM(p.inicio_real),
        fmtHM(p.fin_real),
        p.duracion_real ?? '',
        p.duracion_prog ?? '',
        p.excedido_min ?? '',
      ])
    }
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `pausas_${hoy}.csv`; a.click()
  }

  const EventRow = ({ e, variante }) => {
    const minAway = e.ini > now ? (e.ini - now) * 60 : null
    const minLeft = e.fin  > now ? (e.fin  - now) * 60 : null
    const urgent  = variante === 'proximo' && minAway !== null && minAway <= 15
    const bg = variante === 'activo'
      ? (e.tipo === 'pausa' ? 'bg-amber-50 border-amber-200' : 'bg-teal-50 border-teal-200')
      : variante === 'proximo' && urgent ? 'bg-orange-50 border-orange-200'
      : variante === 'proximo' ? 'bg-white border-gray-200'
      : 'bg-gray-50/50 border-gray-100'
    const tipoBadge = e.tipo === 'pausa'
      ? <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">☕ Break</span>
      : <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700">🍽️ Almuerzo</span>
    return (
      <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${bg}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <p className={`text-sm font-medium truncate ${variante === 'tarde' ? 'text-gray-400' : 'text-gray-800'}`}>
              {e.agente?.split(' ').slice(0, 2).join(' ')}
            </p>
            {variante === 'tarde' ? <span className="opacity-50">{tipoBadge}</span> : tipoBadge}
          </div>
          <p className="text-xs text-gray-500">{e.iniStr} – {e.finStr}{e.linea ? ` · ${e.linea}` : ''}</p>
        </div>
        <div className="text-right shrink-0 text-xs">
          {variante === 'activo'  && <span className="text-gray-400">termina en {Math.max(0, Math.round(minLeft))} min</span>}
          {variante === 'proximo' && <span className={urgent ? 'text-orange-600 font-semibold' : 'text-gray-500'}>{fmtMin(minAway)}</span>}
          {variante === 'tarde'   && <span className="text-gray-400">{fmtMin(minAway)}</span>}
        </div>
      </div>
    )
  }

  if (loading)
    return <div className="flex items-center justify-center py-12 text-gray-400 text-sm">Cargando…</div>

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-700">Monitor de breaks · {localDateISO()}</p>
          <p className="text-xs text-gray-400">Hora actual: <span className="font-mono font-semibold text-gray-600">{nowStr}</span></p>
        </div>
        <div className="flex items-center gap-2">
          {terminadas.length > 0 && (
            <button onClick={exportarCSV}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-gray-300 text-gray-600 hover:bg-gray-50 rounded-lg transition">
              <Download className="w-3.5 h-3.5"/> Exportar CSV
            </button>
          )}
          <button onClick={cargar}
            className="text-xs text-primary-600 hover:bg-primary-50 px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition">
            <RefreshCw className="w-3 h-3"/> Actualizar
          </button>
        </div>
      </div>

      {/* KPIs rápidos de pausas reales */}
      {pausas.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'En pausa ahora',  value: activas.length,                          color: activas.length > 0 ? 'border-orange-400' : 'border-gray-200', bold: activas.length > 0 },
            { label: 'Pausas hoy',      value: terminadas.length,                       color: 'border-gray-200' },
            { label: 'Analistas con exceso', value: resumen.filter(r => r.excedidoMin > 0).length, color: resumen.some(r => r.excedidoMin > 0) ? 'border-red-400' : 'border-gray-200' },
            { label: 'Total excedido',  value: `${resumen.reduce((s,r) => s + r.excedidoMin, 0)} min`, color: 'border-gray-200' },
          ].map(({ label, value, color, bold }) => (
            <div key={label} className={`bg-white rounded-xl border-l-4 ${color} border border-gray-200 px-3 py-2.5`}>
              <p className="text-xs text-gray-500">{label}</p>
              <p className={`text-xl font-bold mt-0.5 ${bold ? 'text-orange-600' : 'text-gray-900'}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs horario vs reales */}
      <div className="flex gap-1 border-b border-gray-200">
        {[['horario','Horario programado'],['reales','Pausas reales']].map(([id, label]) => (
          <button key={id} onClick={() => setVT(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${vistaTab === id ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
            {id === 'reales' && pausas.length > 0 && (
              <span className="ml-1.5 bg-gray-200 text-gray-600 text-xs rounded-full px-1.5">{pausas.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Vista: Horario programado ── */}
      {vistaTab === 'horario' && (
        <div className="space-y-5">
          {lineas.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => setFL('')} className={`px-3 py-1 rounded-full text-xs font-medium transition ${!filtroLinea ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Todas</button>
              {lineas.map(l => (
                <button key={l} onClick={() => setFL(l === filtroLinea ? '' : l)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition ${filtroLinea === l ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {enCurso.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block"/> Ahora · {enCurso.length}
              </p>
              <div className="space-y-1.5">{enCurso.map(e => <EventRow key={e.key} e={e} variante="activo" />)}</div>
            </div>
          )}
          {proximos.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Próximos 90 min · {proximos.length}</p>
              <div className="space-y-1.5">{proximos.map(e => <EventRow key={e.key} e={e} variante="proximo" />)}</div>
            </div>
          )}
          {masTarde.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Más tarde</p>
              <div className="space-y-1">{masTarde.map(e => <EventRow key={e.key} e={e} variante="tarde" />)}</div>
            </div>
          )}
          {eventos.length === 0 && (
            <div className="text-center py-10 text-gray-400">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-30"/>
              <p className="text-sm">No hay breaks ni almuerzos programados para hoy</p>
            </div>
          )}
        </div>
      )}

      {/* ── Vista: Pausas reales ── */}
      {vistaTab === 'reales' && (
        <div className="space-y-5">
          {/* Pausas activas ahora */}
          {activas.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse inline-block"/> En pausa ahora · {activas.length}
              </p>
              <div className="space-y-2">
                {activas.map(p => {
                  const elapsed = Math.floor((Date.now() - new Date(p.inicio_real).getTime()) / 60000)
                  const over    = p.duracion_prog ? elapsed - p.duracion_prog : null
                  return (
                    <div key={p.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${over > 0 ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'}`}>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-gray-800">{p.agente?.split(' ').slice(0,2).join(' ')}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${p.tipo === 'break' ? 'bg-amber-100 text-amber-700' : 'bg-teal-100 text-teal-700'}`}>
                            {p.tipo === 'break' ? '☕' : '🍽️'} {p.tipo}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">Inició: {fmtHM(p.inicio_real)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-mono font-bold tabular-nums ${over > 0 ? 'text-red-600' : 'text-gray-700'}`}>{elapsed} min</p>
                        {p.duracion_prog && (
                          <p className="text-xs text-gray-400">/ {p.duracion_prog} min prog.</p>
                        )}
                        {over > 0 && (
                          <p className="text-xs font-bold text-red-600">+{over} min extra</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Resumen por analista */}
          {resumen.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Resumen por analista</p>
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {['Analista','Pausas','Total (min)','Tiempo excedido','Estado'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {resumen.map(r => (
                      <tr key={r.agente} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5 font-medium text-gray-800">{r.agente}</td>
                        <td className="px-3 py-2.5 text-gray-500">{r.pausas}</td>
                        <td className="px-3 py-2.5 text-gray-700">{r.totalMin} min</td>
                        <td className="px-3 py-2.5">
                          {r.excedidoMin > 0
                            ? <span className="font-bold text-red-600">+{r.excedidoMin} min ({r.excesos} exceso{r.excesos !== 1 ? 's' : ''})</span>
                            : <span className="text-green-600 font-medium">Sin excesos</span>
                          }
                        </td>
                        <td className="px-3 py-2.5">
                          {activas.some(a => a.agente === r.agente)
                            ? <span className="inline-flex items-center gap-1 text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium"><span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse"/>En pausa</span>
                            : <span className="text-xs text-gray-400">Disponible</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Historial detallado */}
          {terminadas.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historial del día</p>
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {['Analista','Tipo','Inicio','Fin','Real','Prog.','Diferencia'].map(h => (
                        <th key={h} className="px-3 py-2 text-left font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {terminadas.map(p => (
                      <tr key={p.id} className={`hover:bg-gray-50 ${(p.excedido_min ?? 0) > 0 ? 'bg-red-50/40' : ''}`}>
                        <td className="px-3 py-2 font-medium text-gray-800">{p.agente?.split(' ').slice(0,2).join(' ')}</td>
                        <td className="px-3 py-2">{p.tipo === 'break' ? '☕ Break' : '🍽️ Almuerzo'}</td>
                        <td className="px-3 py-2 font-mono text-gray-600">{fmtHM(p.inicio_real)}</td>
                        <td className="px-3 py-2 font-mono text-gray-600">{fmtHM(p.fin_real)}</td>
                        <td className="px-3 py-2 font-semibold">{p.duracion_real ?? '—'} min</td>
                        <td className="px-3 py-2 text-gray-400">{p.duracion_prog ?? '—'} min</td>
                        <td className="px-3 py-2">
                          {p.excedido_min == null ? '—'
                            : p.excedido_min > 0
                              ? <span className="font-bold text-red-600">+{p.excedido_min} min</span>
                              : <span className="text-green-600 font-medium">{p.excedido_min} min</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {pausas.length === 0 && (
            <div className="text-center py-10 text-gray-400">
              <Coffee className="w-8 h-8 mx-auto mb-2 opacity-30"/>
              <p className="text-sm">Nadie ha marcado pausas hoy aún</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function VipMisTurnos() {
  const { profile, user } = useAuth()
  const { t } = useTranslation()
  const esAdmin = ['admin','supervisor'].includes(profile?.role)

  const [tab, setTab]           = useState('mis-turnos')
  const [offset, setOffset]     = useState(0)
  const [turnosSemana, setTS]   = useState([])
  const [solicitudes, setSols]  = useState([])
  const [pendientes, setPend]   = useState([])
  const [loading, setLoading]   = useState(true)

  // Modales
  const [turnoParaCambio, setTPC]     = useState(null)
  const [turnoObjetivo, setTO]        = useState(null)
  const [descansoModal, setDM]        = useState(null)
  const [heModal, setHEModal]         = useState(false)
  const [misHE, setMisHE]             = useState([])
  const [turnoEditar, setTE]          = useState(null)   // { turno } | { fecha, agente? } para nuevo
  const [rechazarModal, setRM]        = useState(null)
  const [motivoRechazo, setMotR]      = useState('')
  const [procesando, setProcesando]   = useState(null)
  const [respProgreso, setRProg]      = useState(null)
  const [respExito, setRExito]        = useState(false)

  // Filtros malla
  const [filtroAnalista, setFA]   = useState('')
  const [filtroLinea, setFL]      = useState('')
  const [vistaTimeline, setVT]    = useState(false)

  // Gestión directa (admin/supervisor)
  const [modoGestion, setModoGestion] = useState('individual') // 'individual' | 'semanal'
  const [gestionSel1, setGS1]         = useState(null)
  const [gestionModal, setGModal]     = useState(null)
  const [gestionMotivo, setGMotivo]   = useState('')
  const [gestionGuardando, setGG]     = useState(false)
  const [gestionProgreso, setGProg]   = useState(null)
  const [gestionExito, setGExito]     = useState(false)
  const [gestionFA, setGFA]           = useState('')
  const [gestionFL, setGFL]           = useState('')
  // Modo semanal
  const [semAnalA, setSemAnalA]           = useState('')
  const [semAnalB, setSemAnalB]           = useState('')
  const [diasExcluidos, setDiasExc]       = useState(new Set())
  const [semMotivo, setSemMotivo]         = useState('')
  const [semGuardando, setSemGuard]       = useState(false)
  const [historial, setHistorial]         = useState([])
  const [showHistorial, setShowHist]      = useState(false)
  const [reenviando, setReenviando]       = useState(null)
  const [reenvioMsg, setReenvioMsg]       = useState(null)
  // Rango de fechas (reemplaza el filtro de día único)
  const [filtroDesde, setFD]   = useState('')
  const [filtroHasta, setFH]   = useState('')

  // Config
  const [showConfig, setShowConfig]         = useState(false)
  const [scriptUrl, setScriptUrl]           = useState(() => localStorage.getItem(SCRIPT_URL_KEY) ?? '')
  const [scriptSecret, setScriptSecret]     = useState(() => localStorage.getItem(SCRIPT_SECRET_KEY) ?? '')
  const [nombreTurno, setNombreTurno]       = useState(() => localStorage.getItem(NOMBRE_TURNO_KEY) ?? '')
  const [sheetImportUrl, setSheetImportUrl] = useState(() => localStorage.getItem(SHEET_IMPORT_KEY) ?? '')
  const [importando, setImportando]         = useState(false)
  const [importMsg, setImportMsg]           = useState(null) // { ok, text }

  // Carga la config global desde Supabase (sobreescribe localStorage si hay valores en BD)
  useEffect(() => {
    getVipConfig().then(cfg => {
      if (cfg.script_url)       { setScriptUrl(cfg.script_url);           localStorage.setItem(SCRIPT_URL_KEY,    cfg.script_url) }
      if (cfg.script_secret)    { setScriptSecret(cfg.script_secret);     localStorage.setItem(SCRIPT_SECRET_KEY, cfg.script_secret) }
      if (cfg.sheet_import_url) { setSheetImportUrl(cfg.sheet_import_url); localStorage.setItem(SHEET_IMPORT_KEY,  cfg.sheet_import_url) }
    })
  }, [])

  // Auto-detecta el nombre del analista en el Sheet si aún no está configurado
  useEffect(() => {
    if (!profile?.id || profile?.nombre_turno || nombreTurno.trim()) return
    autoDetectarNombreTurno(profile.full_name).then(async nombre => {
      if (nombre) {
        setNombreTurno(nombre)
        await guardarNombreTurnoEnPerfil(profile.id, nombre).catch(() => {})
      }
    })
  }, [profile?.id])

  const nombreEfectivo = nombreTurno.trim() || profile?.nombre_turno || profile?.full_name || ''

  // Registra el Slack ID automáticamente la primera vez que el analista entra
  useEffect(() => {
    if (nombreEfectivo && user?.email) {
      registrarSlackIdAutomatico(nombreEfectivo, user.email).catch(() => {})
    }
  }, [nombreEfectivo, user?.email])

  // Vista semana / día
  const [vistaMode, setVistaMode] = useState('semana')
  const [diaActivo, setDiaActivo] = useState(localDateISO())

  function irADia(fecha) {
    setDiaActivo(fecha)
    setOffset(offsetParaFecha(fecha))
    setVistaMode('dia')
  }

  const { lunes, domingo } = getLunes(offset)
  const tieneRango = !!(filtroDesde || filtroHasta)

  const cargar = useCallback(async () => {
    setLoading(true)
    // Si hay filtro de rango, usarlo; si no, la semana actual
    const inicio = filtroDesde || toISO(lunes)
    const fin    = filtroHasta || toISO(domingo)
    const [sem, sols] = await Promise.all([
      getTurnosSemana(inicio, fin),
      getSolicitudesCambio(nombreEfectivo),
    ])
    setTS(sem)
    setSols(sols)
    if (esAdmin) setPend(await getSolicitudesPendientesSupervisor())
    setLoading(false)
  }, [toISO(lunes), toISO(domingo), nombreEfectivo, esAdmin, filtroDesde, filtroHasta])

  useEffect(() => { cargar() }, [cargar])

  useEffect(() => {
    if (nombreEfectivo) getMisHorasExtra(nombreEfectivo).then(setMisHE)
  }, [nombreEfectivo])

  // Auto-sincroniza desde Sheet cada 10 minutos si hay URL configurada (solo admin)
  useEffect(() => {
    if (!esAdmin || !sheetImportUrl.trim()) return
    const id = setInterval(async () => {
      try {
        await importarTurnosDesdeSheet(sheetImportUrl.trim())
        await cargar()
      } catch (e) {
        console.error('Auto-sync fallido:', e.message)
      }
    }, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [esAdmin, sheetImportUrl])

  const hoyStr = localDateISO()

  const diasSemana = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lunes); d.setDate(lunes.getDate() + i); return toISO(d)
  })

  const mallafiltrada = turnosSemana.filter(turno =>
    (!filtroAnalista || turno.agente?.toLowerCase().includes(filtroAnalista.toLowerCase())) &&
    (!filtroLinea || turno.linea_atencion === filtroLinea)
  )
  const mallaPorFecha = mallafiltrada.reduce((a, turno) => { if (!a[turno.fecha]) a[turno.fecha] = []; a[turno.fecha].push(turno); return a }, {})

  // Fechas visibles en la malla:
  // - Con rango: todos los días del rango
  // - Sin rango: días de la semana desde HOY en adelante (ocultar pasados)
  const diasVisibles = (() => {
    if (tieneRango) {
      const inicio = filtroDesde || toISO(lunes)
      const fin    = filtroHasta || toISO(domingo)
      return rangoFechas(inicio, fin)
    }
    // Solo hoy y futuro de la semana seleccionada
    return diasSemana.filter(f => f >= hoyStr)
  })()

  const misTurnosSemana = turnosSemana.filter(turno => turno.agente?.toLowerCase() === nombreEfectivo.toLowerCase())
  const lineas = [...new Set(turnosSemana.map(turno => turno.linea_atencion).filter(Boolean))].sort()

  const nombre    = nombreEfectivo.toLowerCase()
  const recibidas = solicitudes.filter(s => s.receptor_nombre?.toLowerCase() === nombre && s.estado === 'pendiente')
  const enviadas  = solicitudes.filter(s => s.solicitante_nombre?.toLowerCase() === nombre)

  const gestionMallaFiltrada = turnosSemana.filter(t =>
    (!gestionFA || t.agente?.toLowerCase().includes(gestionFA.toLowerCase())) &&
    (!gestionFL || t.linea_atencion === gestionFL)
  )
  const gestionPorFecha = gestionMallaFiltrada.reduce((a, t) => {
    if (!a[t.fecha]) a[t.fecha] = []
    a[t.fecha].push(t)
    return a
  }, {})

  // Modo semanal: lista de analistas y pares por día
  const todosLosAnalistas = [...new Set(turnosSemana.map(t => t.agente).filter(Boolean))].sort()
  const paresSemana = diasSemana.map(fecha => {
    const turnoA = turnosSemana.find(t => t.fecha === fecha && t.agente?.toLowerCase() === semAnalA.toLowerCase())
    const turnoB = turnosSemana.find(t => t.fecha === fecha && t.agente?.toLowerCase() === semAnalB.toLowerCase())
    return { fecha, turnoA: turnoA ?? null, turnoB: turnoB ?? null }
  }).filter(p => p.turnoA || p.turnoB)

  function handleGestionClick(turno) {
    if (!gestionSel1) {
      setGS1(turno)
    } else if (gestionSel1.id === turno.id) {
      setGS1(null)
    } else if (gestionSel1.agente?.toLowerCase() === turno.agente?.toLowerCase()) {
      alert('No se puede intercambiar dos turnos del mismo analista.')
    } else {
      setGModal({ sel1: gestionSel1, sel2: turno })
      setGS1(null)
      setGMotivo('')
    }
  }

  async function _sincSheet(turno1, turno2) {
    if (!scriptUrl.trim() || !scriptSecret.trim()) return
    try {
      await aplicarCambioEnSheet(scriptUrl.trim(), scriptSecret.trim(), {
        solicitante_nombre: turno1.agente,
        receptor_nombre:    turno2.agente,
        turno_sol_fecha:    turno1.fecha,
        turno_rec_fecha:    turno2.fecha,
      })
    } catch (e) {
      console.warn('Sheet no actualizado:', e.message)
    }
  }

  async function handleIntercambioDirecto() {
    if (!gestionModal) return
    setGG(true); setGExito(false); setGProg(5)
    try {
      setGProg(20)
      await intercambiarTurnosDirecto(gestionModal.sel1, gestionModal.sel2, profile.full_name, gestionMotivo.trim())
      setGProg(60)
      _sincSheet(gestionModal.sel1, gestionModal.sel2)
      await cargar()
      setGProg(100)
      setGExito(true)

      setTimeout(() => {
        setGModal(null); setGMotivo(''); setGProg(null); setGExito(false)
      }, 2000)
    } catch (e) {
      alert('Error: ' + e.message)
      setGProg(null); setGExito(false)
    }
    setGG(false)
  }

  async function handleIntercambioSemanal() {
    const pares = paresSemana.filter(p => p.turnoA && p.turnoB && !diasExcluidos.has(p.fecha))
    if (!pares.length) return
    setSemGuard(true)
    try {
      // Supabase en paralelo para todos los días
      await Promise.all(
        pares.map(p => intercambiarTurnosDirecto(p.turnoA, p.turnoB, profile.full_name, semMotivo.trim() || null))
      )
      // Sheet syncs en paralelo y sin bloquear (fire-and-forget)
      pares.forEach(p => _sincSheet(p.turnoA, p.turnoB))
      setSemAnalA(''); setSemAnalB(''); setDiasExc(new Set()); setSemMotivo('')
      await cargar()
    } catch (e) { alert('Error: ' + e.message) }
    setSemGuard(false)
  }

  function toggleDiaExcluido(fecha) {
    setDiasExc(prev => {
      const next = new Set(prev)
      next.has(fecha) ? next.delete(fecha) : next.add(fecha)
      return next
    })
  }

  async function cargarHistorial() {
    try {
      const data = await getCambiosAprobadosRecientes(profile.full_name, 7)
      setHistorial(data)
      setShowHist(true)
    } catch (e) { alert(e.message) }
  }

  async function reenviarAlSheet(cambio) {
    if (!scriptUrl.trim() || !scriptSecret.trim()) {
      alert('Configura la URL Web App y la clave secreta en ⚙️ Configuración primero.')
      return
    }
    setReenviando(cambio.id)
    setReenvioMsg(null)
    try {
      await aplicarCambioEnSheet(scriptUrl.trim(), scriptSecret.trim(), cambio)
      setHistorial(prev => prev.filter(c => c.id !== cambio.id))
    } catch (e) {
      const msg = e?.message || (typeof e === 'string' ? e : null) || 'El script no respondió correctamente. Verifica que la URL Web App sea válida y esté publicada.'
      setReenvioMsg({ id: cambio.id, ok: false, text: msg })
    }
    setReenviando(null)
  }

  async function handleResponder(id, aceptar) {
    if (!aceptar) { setRM({ id, tipo: 'receptor' }); return }
    setProcesando(id)
    setRProg(10)
    setRExito(false)
    try {
      await responderSolicitudCambio(id, true, null)
      setRProg(35)
      const resultado = await autoAplicarCambioAceptado(id)
      setRProg(70)
      if (resultado.ok) {
        if (scriptUrl.trim() && scriptSecret.trim()) {
          aplicarCambioEnSheet(scriptUrl.trim(), scriptSecret.trim(), resultado.cambio).catch(() => {})
        }
        setRProg(100)
        setRExito(true)
        await cargar()
        setTimeout(() => { setRExito(false); setRProg(null); setProcesando(null) }, 2500)
        return
      } else if (resultado.motivo?.includes('descanso')) {
        setRProg(null)
        const continuar = window.confirm(
          `⚠️ Advertencia: ${resultado.motivo}\n\n¿Aplicar el cambio de turno de todos modos?`
        )
        if (continuar) {
          setProcesando(id); setRProg(50)
          const forzado = await forzarAplicarCambioAceptado(id)
          if (forzado.ok) {
            if (scriptUrl.trim() && scriptSecret.trim()) {
              aplicarCambioEnSheet(scriptUrl.trim(), scriptSecret.trim(), forzado.cambio).catch(() => {})
            }
            setRProg(100); setRExito(true)
            await cargar()
            setTimeout(() => { setRExito(false); setRProg(null); setProcesando(null) }, 2500)
            return
          } else {
            await rechazarCambioSupervisor(id, 'Sistema', forzado.motivo)
            alert(`Cambio no aplicado: ${forzado.motivo}`)
          }
        } else {
          await rechazarCambioSupervisor(id, 'Sistema', resultado.motivo)
        }
      } else {
        setRProg(null)
        await rechazarCambioSupervisor(id, 'Sistema', resultado.motivo)
        alert(`Cambio no aplicado: ${resultado.motivo}`)
      }
      await cargar()
    } catch (e) { alert(e.message); setRProg(null) }
    setProcesando(null)
  }

  async function handleRechazarConfirm() {
    setProcesando(rechazarModal.id)
    try {
      if (rechazarModal.tipo === 'receptor') await responderSolicitudCambio(rechazarModal.id, false, motivoRechazo)
      else await rechazarCambioSupervisor(rechazarModal.id, profile.full_name, motivoRechazo)
      setRM(null); setMotR(''); await cargar()
    } catch (e) { alert(e.message) }
    setProcesando(null)
  }

  async function handleAprobar(cambio) {
    setProcesando(cambio.id)
    try {
      await aplicarCambioEnSupabase(cambio)
      await aprobarCambio(cambio.id, profile.full_name)
      if (scriptUrl.trim() && scriptSecret.trim()) {
        try { await aplicarCambioEnSheet(scriptUrl.trim(), scriptSecret.trim(), cambio) } catch {}
      }
      await cargar()
    } catch (e) { alert('Error al aprobar: ' + e.message) }
    setProcesando(null)
  }

  async function handleCancelar(id) {
    if (!confirm(t('turnos.cancelarSolicitud') + '?')) return
    setProcesando(id)
    try { await cancelarSolicitudCambio(id); await cargar() } catch (e) { alert(e.message) }
    setProcesando(null)
  }

  function limpiarRango() { setFD(''); setFH('') }

  async function handleImportar() {
    const url = sheetImportUrl.trim()
    if (!url) { setShowConfig(true); return }
    setImportando(true)
    setImportMsg(null)
    try {
      const n = await importarTurnosDesdeSheet(url)
      setImportMsg({ ok: true, text: `✓ ${n} turnos sincronizados desde el Sheet.` })
      await cargar()
    } catch (e) {
      setImportMsg({ ok: false, text: e.message })
    }
    setImportando(false)
  }

  const tabs = [
    ['mis-turnos', t('turnos.misTurnos')],
    ['malla', t('turnos.malla')],
    ['solicitudes', recibidas.length > 0 ? `${t('turnos.solicitudes')} (${recibidas.length})` : t('turnos.solicitudes')],
    ...(esAdmin ? [['aprobar', (() => { const n = pendientes.filter(s=>s.estado==='aceptado').length; return n > 0 ? `${t('turnos.aprobar')} (${n})` : t('turnos.aprobar') })()] ] : []),
    ...(esAdmin ? [['gestion', 'Gestión directa']] : []),
    ...(esAdmin ? [['breaks', 'Monitor Breaks']] : []),
  ]

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary-600"/> {t('turnos.title')}
          </h1>
          <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
            <User className="w-3 h-3"/> {nombreEfectivo || '—'}
            {!nombreTurno.trim() && !profile?.nombre_turno && (
              <button onClick={() => setShowConfig(true)} className="underline hover:text-gray-600 ml-1">{t('turnos.nombreIncorrecto')}</button>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {esAdmin && (
            <button onClick={handleImportar} disabled={importando}
              title="Sincronizar turnos desde Google Sheet"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg disabled:opacity-50 transition">
              <Download className={`w-3.5 h-3.5 ${importando ? 'animate-bounce' : ''}`}/>
              {importando ? 'Sincronizando…' : 'Sincronizar Sheet'}
            </button>
          )}
          <button onClick={cargar} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}/>
          </button>
          <button onClick={() => setShowConfig(v => !v)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <Settings className="w-4 h-4"/>
          </button>
        </div>
      </div>

      {/* Mensaje resultado importación */}
      {importMsg && (
        <div className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-sm ${importMsg.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
          <span>{importMsg.text}</span>
          <button onClick={() => setImportMsg(null)} className="ml-3 opacity-60 hover:opacity-100"><X className="w-4 h-4"/></button>
        </div>
      )}

      {/* Config */}
      {showConfig && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-blue-800">{t('turnos.configuracion')}</p>
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">{t('turnos.nombreSheet')} <span className="text-gray-400">({t('turnos.override')})</span></label>
            <input value={nombreTurno} onChange={e => setNombreTurno(e.target.value)}
              placeholder={profile?.nombre_turno || profile?.full_name}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            <p className="text-xs text-gray-400 mt-1">{t('turnos.activoBD')}: <strong>{profile?.nombre_turno || t('turnos.noConfigurado')}</strong></p>
          </div>
          {esAdmin && (
            <>
              <hr className="border-blue-200"/>
              <p className="text-xs font-semibold text-blue-700">Importar desde Google Sheet</p>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-1">URL del Google Sheet <span className="text-gray-400">(debe estar publicado como CSV)</span></label>
                <input value={sheetImportUrl} onChange={e => setSheetImportUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <p className="text-xs text-gray-400 mt-1">Archivo → Compartir → Publicar en la web → CSV</p>
              </div>
              <hr className="border-blue-200"/>
              <p className="text-xs font-semibold text-blue-700">{t('turnos.appsScript')} <span className="font-normal text-blue-500">(para aplicar cambios al Sheet)</span></p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">{t('turnos.urlWebApp')}</label>
                  <input value={scriptUrl} onChange={e => setScriptUrl(e.target.value)}
                    placeholder="https://script.google.com/macros/s/.../exec"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">{t('turnos.claveSecreta')}</label>
                  <input value={scriptSecret} onChange={e => setScriptSecret(e.target.value)}
                    placeholder="mi_clave_secreta"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                </div>
              </div>
            </>
          )}
          <button onClick={async () => {
            localStorage.setItem(NOMBRE_TURNO_KEY, nombreTurno.trim())
            if (esAdmin) {
              localStorage.setItem(SCRIPT_URL_KEY, scriptUrl.trim())
              localStorage.setItem(SCRIPT_SECRET_KEY, scriptSecret.trim())
              localStorage.setItem(SHEET_IMPORT_KEY, sheetImportUrl.trim())
              await saveVipConfig({
                script_url:       scriptUrl.trim(),
                script_secret:    scriptSecret.trim(),
                sheet_import_url: sheetImportUrl.trim(),
              }).catch(() => {})
            }
            setShowConfig(false); cargar()
          }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            {t('turnos.guardarRecargar')}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 overflow-x-auto">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`py-3 px-4 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === id ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">{t('turnos.cargando')}</div>
      ) : (
        <>
          {/* ── MIS TURNOS ── */}
          {tab === 'mis-turnos' && (
            <div className="space-y-4">
              <div className="flex flex-col lg:flex-row gap-4 items-start">
                {/* Calendario mensual */}
                <CalendarioMes
                  nombre={nombreEfectivo}
                  onNavegar={irADia}
                />
                {/* Calendario semanal / diario */}
                <div className="flex-1 min-w-0 space-y-3">
                  <div className="flex items-center gap-2">
                    {/* Toggle Semana / Día */}
                    <div className="flex rounded-lg border border-gray-200 overflow-hidden shrink-0">
                      <button
                        onClick={() => setVistaMode('semana')}
                        className={`px-3 py-1.5 text-xs font-medium transition ${vistaMode === 'semana' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                        Semana
                      </button>
                      <button
                        onClick={() => setVistaMode('dia')}
                        className={`px-3 py-1.5 text-xs font-medium transition border-l border-gray-200 ${vistaMode === 'dia' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                        Día
                      </button>
                    </div>
                    {/* Navegador */}
                    <div className="flex-1">
                      {vistaMode === 'semana'
                        ? <NavSemana offset={offset} onChange={setOffset}/>
                        : <NavDia fecha={diaActivo} onNavegar={irADia}/>
                      }
                    </div>
                    <button onClick={() => setHEModal(true)}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-xl transition shrink-0">
                      <PlusCircle className="w-3.5 h-3.5"/> Reportar HE
                    </button>
                  </div>
                  {turnosSemana.length === 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
                      No hay turnos programados esta semana en el sistema. Sincroniza el Sheet o usa Gestión directa para agregar turnos.
                    </div>
                  )}
                  {/* Widget de pausas — solo muestra en día de hoy */}
                  {(vistaMode === 'dia' ? diaActivo === hoyStr : diasSemana.includes(hoyStr)) && !esAdmin && (
                    <PausaWidget
                      turnoHoy={misTurnosSemana.find(t => t.fecha === hoyStr)}
                      nombreEfectivo={nombreEfectivo}
                    />
                  )}
                  <CalendarioSemana
                    diasSemana={vistaMode === 'dia' ? [diaActivo] : diasSemana}
                    misTurnos={misTurnosSemana}
                    solicitudes={solicitudes}
                    nombre={nombre}
                    hoyStr={hoyStr}
                    onCambiar={setTPC}
                    onDescanso={setDM}
                  />
                </div>
              </div>
              {/* Horas extra recientes */}
              {misHE.length > 0 && (
                <div className="bg-orange-50 border border-orange-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-orange-200 flex items-center justify-between">
                    <p className="text-xs font-semibold text-orange-800 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5"/> Horas extra reportadas
                    </p>
                    <span className="text-xs font-bold text-orange-700">
                      {misHE.reduce((a, h) => a + (h.horas_extra ?? 0), 0).toFixed(1)}h total registradas
                    </span>
                  </div>
                  <div className="divide-y divide-orange-100">
                    {misHE.slice(0, 6).map(he => (
                      <div key={he.id} className="px-4 py-2.5 flex items-start gap-3">
                        <div className="shrink-0 text-center w-10">
                          <p className="text-xs font-bold text-orange-700">{new Date(he.fecha + 'T12:00:00').getDate()}</p>
                          <p className="text-[10px] text-orange-500 uppercase">{MESES[new Date(he.fecha + 'T12:00:00').getMonth()]}</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold text-orange-800">{he.horas_extra}h extra</span>
                            {he.aprobado_por && (
                              <span className="text-[10px] text-orange-600 bg-orange-100 border border-orange-200 px-1.5 py-0.5 rounded-full">
                                ✓ {he.aprobado_por}
                              </span>
                            )}
                          </div>
                          {he.comentario && <p className="text-xs text-gray-600 mt-0.5 line-clamp-1">{he.comentario}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MALLA COMPLETA ── */}
          {tab === 'malla' && (
            <div className="space-y-4">
              {/* Navegador de semana — solo cuando no hay rango activo */}
              {!tieneRango && <NavSemana offset={offset} onChange={setOffset}/>}

              {/* Filtros */}
              <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('turnos.filtros')}</p>
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    <button onClick={() => setVT(false)}
                      className={`px-3 py-1.5 font-medium transition ${!vistaTimeline ? 'bg-primary-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                      Lista
                    </button>
                    <button onClick={() => setVT(true)}
                      className={`px-3 py-1.5 font-medium transition ${vistaTimeline ? 'bg-primary-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                      Visual
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Analista */}
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">{t('turnos.buscarAnalista')}</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"/>
                      <input value={filtroAnalista} onChange={e => setFA(e.target.value)}
                        placeholder={t('turnos.buscarAnalista')}
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
                    </div>
                  </div>
                  {/* Línea */}
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">{t('turnos.linea')}</label>
                    <select value={filtroLinea} onChange={e => setFL(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
                      <option value="">{t('turnos.todasLineas')}</option>
                      {lineas.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  {/* Desde */}
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">{t('vip.desde')}</label>
                    <input
                      type="date"
                      value={filtroDesde}
                      onChange={e => {
                        setFD(e.target.value)
                        if (e.target.value) setOffset(offsetParaFecha(e.target.value))
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                    />
                  </div>
                  {/* Hasta */}
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">{t('vip.hasta')}</label>
                    <input
                      type="date"
                      value={filtroHasta}
                      min={filtroDesde || undefined}
                      onChange={e => setFH(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                    />
                  </div>
                </div>
                {(filtroAnalista || filtroLinea || tieneRango) && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={() => { setFA(''); setFL(''); limpiarRango() }}
                      className="text-xs text-primary-600 hover:text-primary-800 underline">
                      {t('turnos.limpiarFiltros')}
                    </button>
                    <span className="text-xs text-gray-400">
                      {mallafiltrada.length} {mallafiltrada.length !== 1 ? t('turnos.resultados') : t('turnos.resultado')}
                    </span>
                    {!tieneRango && (
                      <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                        {t('turnos.soloHoyFuturo')}
                      </span>
                    )}
                  </div>
                )}
                {!tieneRango && !filtroAnalista && !filtroLinea && (
                  <p className="text-xs text-gray-400">{t('turnos.soloHoyFuturo')}</p>
                )}
              </div>

              {/* Días */}
              {diasVisibles.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <Calendar className="w-8 h-8 mx-auto mb-2 opacity-40"/>
                  <p className="text-sm">{tieneRango ? t('turnos.noTurnosRango') : t('turnos.noTurnosSemana')}</p>
                </div>
              ) : (
                diasVisibles.map(fecha => {
                  const turnos = mallaPorFecha[fecha] ?? []
                  if (turnos.length === 0 && (filtroAnalista || filtroLinea)) return null
                  const hoy  = esHoy(fecha)
                  const d    = new Date(fecha + 'T12:00:00')
                  const label = `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`
                  return (
                    <div key={fecha} className={`rounded-xl border overflow-hidden ${hoy ? 'border-primary-300' : 'border-gray-200'}`}>
                      <div className={`px-4 py-2 flex items-center justify-between ${hoy ? 'bg-primary-50' : 'bg-gray-50'}`}>
                        <p className={`text-sm font-semibold ${hoy ? 'text-primary-700' : 'text-gray-600'}`}>
                          {label}
                          {hoy && <span className="ml-2 text-xs bg-primary-600 text-white px-1.5 py-0.5 rounded-full">{t('turnos.hoy')}</span>}
                        </p>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-gray-400">{turnos.length} {turnos.length !== 1 ? t('turnos.turnos') : t('turnos.turno')}</p>
                          {esAdmin && (
                            <button onClick={() => setTE({ fecha, agente: '', turno_inicio: null })}
                              title="Agregar turno en este día"
                              className="text-xs text-primary-600 hover:bg-primary-100 px-1.5 py-0.5 rounded-lg transition font-medium">
                              + Agregar
                            </button>
                          )}
                        </div>
                      </div>
                      {turnos.length === 0
                        ? <p className="px-4 py-3 text-xs text-gray-300">{t('turnos.sinTurnos')}</p>
                        : vistaTimeline
                          ? <TimelineDay turnos={turnos} esAdmin={esAdmin} onEditar={setTE} hoy={hoy} />
                          : <div className="divide-y divide-gray-100">
                            {turnos.map(turno => {
                              const esMio  = turno.agente?.toLowerCase() === nombre
                              const futuro = new Date(`${turno.fecha}T${turno.turno_inicio || '00:00'}`) > new Date()
                              const bloq   = solicitudes.some(s =>
                                ['pendiente','aceptado'].includes(s.estado) && (
                                  (s.turno_rec_fecha === turno.fecha && s.receptor_nombre?.toLowerCase() === turno.agente?.toLowerCase()) ||
                                  (s.turno_sol_fecha === turno.fecha && s.solicitante_nombre?.toLowerCase() === turno.agente?.toLowerCase())
                                ))
                              return (
                                <div key={turno.id ?? `${turno.agente}-${turno.fecha}-${turno.turno_inicio}`}
                                  className={`px-4 py-2.5 flex items-center justify-between gap-3 ${esMio ? 'bg-primary-50' : 'bg-white'}`}>
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    {esMio && <User className="w-3.5 h-3.5 text-primary-600 shrink-0"/>}
                                    <div className="min-w-0">
                                      <span className={`text-sm truncate block ${esMio ? 'font-semibold text-primary-800' : 'text-gray-700'}`}>{turno.agente}</span>
                                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                        {turno.linea_atencion && <span className="text-xs text-gray-400">{turno.linea_atencion}</span>}
                                        {turno.email && <ModalidadBadge email={turno.email} />}
                                      </div>
                                    </div>
                                    {turno.novedad && <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full shrink-0">{turno.novedad}</span>}
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {esDescanso(turno)
                                      ? <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Descanso</span>
                                      : <span className={`text-xs tabular-nums ${esMio ? 'text-primary-700 font-medium' : 'text-gray-500'}`}>{formatH(turno.turno_inicio)} – {formatH(turno.turno_fin)}</span>
                                    }
                                    {!esMio && futuro && (
                                      bloq
                                        ? <span className="text-xs text-gray-300 px-2 py-1">{t('turnos.bloqueado')}</span>
                                        : <button onClick={() => setTO(turno)}
                                            className="flex items-center gap-1 text-xs text-primary-700 bg-primary-50 hover:bg-primary-100 px-2 py-1 rounded-lg transition border border-primary-200">
                                            <ArrowLeftRight className="w-3 h-3"/> {t('turnos.solicitar')}
                                          </button>
                                    )}
                                    {esMio && futuro && (
                                      <button onClick={() => setTPC(turno)}
                                        className="flex items-center gap-1 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-lg transition">
                                        <ArrowLeftRight className="w-3 h-3"/> {t('turnos.cambiar')}
                                      </button>
                                    )}
                                    {esAdmin && (
                                      <button onClick={() => setTE(turno)}
                                        title="Editar turno"
                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition">
                                        <Pencil className="w-3.5 h-3.5"/>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                      }
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* ── SOLICITUDES ── */}
          {tab === 'solicitudes' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('turnos.recibidas')}</h3>
                {recibidas.length === 0
                  ? <p className="text-sm text-gray-400">{t('turnos.noRecibidas')}</p>
                  : <div className="space-y-3">
                      {recibidas.map(s => (
                        <div key={s.id} className="bg-white border border-amber-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold text-gray-900">{s.solicitante_nombre}</p>
                              <p className="text-xs text-gray-500">{t('turnos.quiereIntercambiar')}</p>
                            </div>
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${BADGE[s.estado]}`}>{getLabelEstado(s.estado, t)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div className="bg-orange-50 rounded-lg p-2">
                              <p className="font-semibold text-orange-700 mb-0.5">{t('turnos.tuTurnoCederias')}</p>
                              <p className="font-medium">{formatFecha(s.turno_rec_fecha)}</p>
                              <p className="text-gray-500">{formatH(s.turno_rec_inicio)} – {formatH(s.turno_rec_fin)}</p>
                            </div>
                            <div className="bg-blue-50 rounded-lg p-2">
                              <p className="font-semibold text-blue-700 mb-0.5">{t('turnos.turnoRecibirias')}</p>
                              <p className="font-medium">{formatFecha(s.turno_sol_fecha)}</p>
                              <p className="text-gray-500">{formatH(s.turno_sol_inicio)} – {formatH(s.turno_sol_fin)}</p>
                            </div>
                          </div>
                          {s.motivo && <p className="text-xs text-gray-500 italic">"{s.motivo}"</p>}
                          <div className="flex gap-2">
                            <button onClick={() => handleResponder(s.id, true)} disabled={procesando === s.id}
                              className="flex-1 py-2 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5">
                              <CheckCircle className="w-3.5 h-3.5"/> {t('turnos.aceptar')}
                            </button>
                            <button onClick={() => handleResponder(s.id, false)} disabled={procesando === s.id}
                              className="flex-1 py-2 border border-gray-300 rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
                              <XCircle className="w-3.5 h-3.5"/> {t('turnos.rechazar')}
                            </button>
                          </div>
                          {procesando === s.id && respProgreso !== null && (
                            <div className="space-y-1.5 pt-1">
                              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                                <div className={`h-full rounded-full transition-all duration-300 ${respExito ? 'bg-green-500' : 'bg-primary-500'}`}
                                  style={{ width: `${respProgreso}%` }} />
                              </div>
                              {respExito
                                ? <p className="text-xs text-green-600 text-center font-medium">✓ ¡Cambio aplicado con éxito!</p>
                                : <p className="text-xs text-gray-500 text-center">
                                    {respProgreso < 35 ? 'Registrando aceptación…'
                                      : respProgreso < 70 ? 'Aplicando intercambio…'
                                      : 'Sincronizando…'} {respProgreso}%
                                  </p>
                              }
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                }
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('turnos.enviadas')}</h3>
                {enviadas.length === 0
                  ? <p className="text-sm text-gray-400">{t('turnos.noEnviadas')}</p>
                  : <div className="space-y-3">
                      {enviadas.map(s => (
                        <div key={s.id} className="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-gray-900">{t('turnos.cambioConX')} {s.receptor_nombre}</p>
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${BADGE[s.estado] ?? 'bg-gray-100 text-gray-500'}`}>{getLabelEstado(s.estado, t)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div className="bg-orange-50 rounded-lg p-2">
                              <p className="font-semibold text-orange-700 mb-0.5">{t('turnos.cederias')}</p>
                              <p>{formatFecha(s.turno_sol_fecha)} · {formatH(s.turno_sol_inicio)}–{formatH(s.turno_sol_fin)}</p>
                            </div>
                            <div className="bg-blue-50 rounded-lg p-2">
                              <p className="font-semibold text-blue-700 mb-0.5">{t('turnos.recibirias')}</p>
                              <p>{formatFecha(s.turno_rec_fecha)} · {formatH(s.turno_rec_inicio)}–{formatH(s.turno_rec_fin)}</p>
                            </div>
                          </div>
                          {s.motivo_rechazo && <p className="text-xs text-red-600 italic">{t('turnos.rechazo')}: "{s.motivo_rechazo}"</p>}
                          {s.aprobado_por && s.estado === 'aprobado' && <p className="text-xs text-green-600">{t('turnos.aprobadoPor')} {s.aprobado_por}</p>}
                          {s.estado === 'pendiente' && (
                            <button onClick={() => handleCancelar(s.id)} disabled={procesando === s.id}
                              className="text-xs text-gray-400 hover:text-red-500 transition mt-1">
                              {t('turnos.cancelarSolicitud')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                }
              </div>
            </div>
          )}

          {/* ── APROBAR ── */}
          {tab === 'aprobar' && esAdmin && (() => {
            const paraAprobar = pendientes.filter(s => s.estado === 'aceptado')
            const enCurso     = pendientes.filter(s => s.estado === 'pendiente')
            const tarjeta = (s, accionable) => (
              <div key={s.id} className={`bg-white border rounded-xl p-4 space-y-3 ${accionable ? 'border-gray-200' : 'border-dashed border-gray-200 opacity-80'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{s.solicitante_nombre} ↔ {s.receptor_nombre}</p>
                    <p className="text-xs text-gray-400">{t('turnos.solicitadoEl')} {new Date(s.created_at).toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'2-digit'})}</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${accionable ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                    {accionable ? t('turnos.listoParaAprobar') : t('turnos.esperandoReceptor')}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="font-semibold text-gray-700 mb-1">{s.solicitante_nombre}</p>
                    <p className="text-gray-500">{t('turnos.cede')}: {formatFecha(s.turno_sol_fecha)} {formatH(s.turno_sol_inicio)}–{formatH(s.turno_sol_fin)}</p>
                    <p className="text-gray-500">{t('turnos.recibe')}: {formatFecha(s.turno_rec_fecha)}</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="font-semibold text-gray-700 mb-1">{s.receptor_nombre}</p>
                    <p className="text-gray-500">{t('turnos.cede')}: {formatFecha(s.turno_rec_fecha)} {formatH(s.turno_rec_inicio)}–{formatH(s.turno_rec_fin)}</p>
                    <p className="text-gray-500">{t('turnos.recibe')}: {formatFecha(s.turno_sol_fecha)}</p>
                  </div>
                </div>
                {s.motivo && <p className="text-xs text-gray-500 italic">{t('turnos.motivo')}: "{s.motivo}"</p>}
                {accionable && (
                  <div className="flex gap-2">
                    <button onClick={() => handleAprobar(s)} disabled={procesando === s.id}
                      className="flex-1 py-2 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5"/> {procesando === s.id ? t('turnos.aplicando') : t('turnos.aprobarAplicar')}
                    </button>
                    <button onClick={() => setRM({ id: s.id, tipo: 'supervisor' })} disabled={procesando === s.id}
                      className="flex-1 py-2 border border-gray-300 rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
                      <XCircle className="w-3.5 h-3.5"/> {t('turnos.rechazar')}
                    </button>
                  </div>
                )}
              </div>
            )
            return (
              <div className="space-y-5">
                {paraAprobar.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{t('turnos.listosAprobar')} ({paraAprobar.length})</p>
                    <div className="space-y-4">{paraAprobar.map(s => tarjeta(s, true))}</div>
                  </div>
                )}
                {enCurso.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{t('turnos.enCursoAprobar')} ({enCurso.length})</p>
                    <div className="space-y-4">{enCurso.map(s => tarjeta(s, false))}</div>
                  </div>
                )}
                {pendientes.length === 0 && (
                  <div className="text-center py-12 text-gray-400">
                    <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-40"/>
                    <p className="text-sm">{t('turnos.noSolicitudes')}</p>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── GESTIÓN DIRECTA (solo admin/supervisor) ── */}
          {tab === 'gestion' && esAdmin && (
            <div className="space-y-4">
              <NavSemana offset={offset} onChange={setOffset}/>

              {/* Toggle modo */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
                {[['individual','Intercambio individual'],['semanal','Intercambio semanal']].map(([m, label]) => (
                  <button key={m} onClick={() => setModoGestion(m)}
                    className={`px-4 py-2 text-sm font-medium transition ${modoGestion === m ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* ── Reenviar cambios al Sheet ── */}
              <div className="flex items-center justify-between">
                <button onClick={cargarHistorial}
                  className="text-xs text-primary-600 hover:text-primary-800 underline flex items-center gap-1">
                  <RefreshCw className="w-3 h-3"/> Ver cambios recientes · reenviar al Sheet
                </button>
              </div>
              {showHistorial && (
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b">
                    <p className="text-xs font-semibold text-gray-600">Cambios aprobados (últimos 7 días)</p>
                    <button onClick={() => setShowHist(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4"/></button>
                  </div>
                  {historial.length === 0 ? (
                    <p className="text-xs text-gray-400 px-4 py-3">Sin cambios registrados en los últimos 7 días.</p>
                  ) : (
                    <div className="divide-y divide-gray-50">
                      {historial.map(c => {
                        const msg = reenvioMsg?.id === c.id ? reenvioMsg : null
                        return (
                          <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                            <div className="flex-1 min-w-0 text-xs text-gray-700">
                              <span className="font-semibold">{c.solicitante_nombre}</span>
                              <span className="text-gray-400"> ({formatFecha(c.turno_sol_fecha)})</span>
                              <ArrowLeftRight className="w-3 h-3 inline mx-1 text-gray-400"/>
                              <span className="font-semibold">{c.receptor_nombre}</span>
                              <span className="text-gray-400"> ({formatFecha(c.turno_rec_fecha)})</span>
                            </div>
                            {msg ? (
                              <span className={`text-xs font-medium ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>
                                {msg.ok ? '✓ Enviado al Sheet' : `✗ ${reenvioMsg.text}`}
                              </span>
                            ) : (
                              <button onClick={() => reenviarAlSheet(c)} disabled={!!reenviando}
                                className="shrink-0 text-xs px-3 py-1.5 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
                                {reenviando === c.id ? 'Enviando…' : 'Reenviar al Sheet'}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── MODO SEMANAL ── */}
              {modoGestion === 'semanal' && (
                <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
                  <p className="text-xs text-gray-500">Selecciona los dos analistas. Se mostrarán sus turnos de la semana. Desmarca los días que quieras excluir del intercambio.</p>

                  {/* Selectores de analistas */}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: 'Analista A', val: semAnalA, set: setSemAnalA },
                      { label: 'Analista B', val: semAnalB, set: setSemAnalB },
                    ].map(({ label, val, set }) => (
                      <div key={label}>
                        <label className="text-xs font-medium text-gray-700 block mb-1">{label}</label>
                        <select value={val} onChange={e => set(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
                          <option value="">— Seleccionar —</option>
                          {todosLosAnalistas.filter(a => a !== (label === 'Analista A' ? semAnalB : semAnalA)).map(a => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {/* Tabla de días */}
                  {semAnalA && semAnalB && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Días de la semana</p>
                      <div className="rounded-xl border border-gray-200 overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 w-8">
                                <input type="checkbox" checked={diasExcluidos.size === 0}
                                  onChange={() => setDiasExc(new Set())}
                                  title="Seleccionar todos" className="rounded"/>
                              </th>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Día</th>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">{semAnalA}</th>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">{semAnalB}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {paresSemana.map(({ fecha, turnoA, turnoB }) => {
                              const excluido = diasExcluidos.has(fecha)
                              const ambos = turnoA && turnoB
                              return (
                                <tr key={fecha} className={`${excluido || !ambos ? 'opacity-40' : 'hover:bg-gray-50'}`}>
                                  <td className="px-3 py-2">
                                    <input type="checkbox"
                                      checked={!excluido && ambos}
                                      disabled={!ambos}
                                      onChange={() => toggleDiaExcluido(fecha)}
                                      className="rounded"/>
                                  </td>
                                  <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">
                                    {formatFecha(fecha)}
                                    {!ambos && <span className="ml-2 text-xs text-gray-400">(falta un turno)</span>}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-gray-600">
                                    {turnoA ? `${formatH(turnoA.turno_inicio)}–${formatH(turnoA.turno_fin)}` : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-gray-600">
                                    {turnoB ? `${formatH(turnoB.turno_inicio)}–${formatH(turnoB.turno_fin)}` : '—'}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Motivo y botón */}
                      <input value={semMotivo} onChange={e => setSemMotivo(e.target.value)}
                        placeholder="Motivo del intercambio (opcional)…"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"/>
                      <button onClick={handleIntercambioSemanal}
                        disabled={semGuardando || paresSemana.filter(p => p.turnoA && p.turnoB && !diasExcluidos.has(p.fecha)).length === 0}
                        className="w-full py-2.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2">
                        <ArrowLeftRight className="w-4 h-4"/>
                        {semGuardando ? 'Aplicando…' : `Intercambiar ${paresSemana.filter(p => p.turnoA && p.turnoB && !diasExcluidos.has(p.fecha)).length} día(s)`}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── MODO INDIVIDUAL (existente) ── */}
              {modoGestion === 'individual' && (<>
              {/* Instrucción */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
                <strong>Modo gestión directa:</strong> selecciona dos turnos para intercambiarlos sin pasar por el flujo de solicitudes. El cambio queda registrado como aprobado por ti.
              </div>

              {/* Filtros */}
              <div className="flex flex-wrap gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"/>
                  <input value={gestionFA} onChange={e => setGFA(e.target.value)}
                    placeholder="Buscar analista…"
                    className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 w-48"/>
                </div>
                <select value={gestionFL} onChange={e => setGFL(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
                  <option value="">Todas las líneas</option>
                  {lineas.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>

              {/* Banner turno seleccionado */}
              {gestionSel1 && (
                <div className="flex items-center justify-between bg-blue-50 border border-blue-300 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-2 text-sm text-blue-800">
                    <ArrowLeftRight className="w-4 h-4 shrink-0"/>
                    <span><strong>{gestionSel1.agente}</strong> · {formatFecha(gestionSel1.fecha)} · {formatH(gestionSel1.turno_inicio)}–{formatH(gestionSel1.turno_fin)}</span>
                    <span className="text-blue-500 text-xs">→ haz clic en el turno a intercambiar</span>
                  </div>
                  <button onClick={() => setGS1(null)} className="text-blue-400 hover:text-blue-600 p-1">
                    <X className="w-4 h-4"/>
                  </button>
                </div>
              )}

              {/* Turnos agrupados por día */}
              {diasSemana.map(fecha => {
                const turnos = gestionPorFecha[fecha] ?? []
                if (!turnos.length) return null
                const esFuturo = fecha >= hoyStr
                return (
                  <div key={fecha}>
                    <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${esHoy(fecha) ? 'text-primary-700' : 'text-gray-400'}`}>
                      {formatFecha(fecha)}{esHoy(fecha) && <span className="ml-2 text-primary-600 bg-primary-100 px-1.5 py-0.5 rounded-full normal-case font-medium">Hoy</span>}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {turnos.map(turno => {
                        const isSel = gestionSel1?.id === turno.id
                        return (
                          <button
                            key={turno.id}
                            onClick={() => esFuturo && handleGestionClick(turno)}
                            disabled={!esFuturo}
                            className={`text-left rounded-xl border px-4 py-3 transition-all ${
                              isSel
                                ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-400'
                                : esFuturo
                                  ? 'border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50 cursor-pointer'
                                  : 'border-gray-100 bg-gray-50 opacity-50 cursor-default'
                            }`}
                          >
                            <p className="font-semibold text-sm text-gray-900 truncate">{turno.agente}</p>
                            <p className="text-xs text-gray-500 mt-0.5">{formatH(turno.turno_inicio)}–{formatH(turno.turno_fin)}</p>
                            {turno.linea_atencion && <p className="text-xs text-gray-400 mt-0.5">{turno.linea_atencion}</p>}
                            {isSel && <p className="text-xs text-blue-600 font-medium mt-1">✓ Seleccionado</p>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {gestionMallaFiltrada.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <Calendar className="w-8 h-8 mx-auto mb-2 opacity-40"/>
                  <p className="text-sm">Sin turnos para esta semana</p>
                </div>
              )}
              </>)}
            </div>
          )}
          {/* ── MONITOR BREAKS (solo admin/supervisor) ── */}
          {tab === 'breaks' && esAdmin && (
            <div className="max-w-xl">
              <BreaksMonitor />
            </div>
          )}
        </>
      )}

      {/* Modal cambio desde MIS TURNOS */}
      {turnoParaCambio && (
        <SolicitarModal
          miTurno={turnoParaCambio}
          turnosPropios={misTurnosSemana}
          todosLosTurnos={turnosSemana}
          solicitudesActivas={solicitudes}
          nombreEfectivo={nombreEfectivo}
          onClose={() => setTPC(null)}
          onCreado={() => { setTPC(null); cargar() }}
        />
      )}

      {/* Modal cambio desde MALLA */}
      {turnoObjetivo && (
        <SolicitarDesdeMallaModal
          turnoObjetivo={turnoObjetivo}
          solicitudesActivas={solicitudes}
          nombreEfectivo={nombreEfectivo}
          onClose={() => setTO(null)}
          onCreado={() => { setTO(null); cargar() }}
        />
      )}

      {/* Modal reportar horas extra */}
      {heModal && (
        <ReportarHEModal
          nombreEfectivo={nombreEfectivo}
          onClose={() => setHEModal(false)}
          onCreado={() => { setHEModal(false); getMisHorasExtra(nombreEfectivo).then(setMisHE) }}
        />
      )}

      {/* Modal cambiar descanso */}
      {descansoModal && (
        <CambiarDescansoModal
          miDescanso={descansoModal}
          turnosSemana={turnosSemana}
          solicitudesActivas={solicitudes}
          nombreEfectivo={nombreEfectivo}
          onClose={() => setDM(null)}
          onCreado={() => { setDM(null); cargar() }}
        />
      )}

      {/* Modal confirmación intercambio directo */}
      {gestionModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4 text-primary-600"/> Confirmar intercambio
              </h3>
              <button onClick={() => setGModal(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5"/></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[gestionModal.sel1, gestionModal.sel2].map((turno, i) => (
                <div key={i} className={`rounded-xl border p-3 text-xs space-y-0.5 ${i === 0 ? 'border-blue-200 bg-blue-50' : 'border-purple-200 bg-purple-50'}`}>
                  <p className={`font-bold text-sm ${i === 0 ? 'text-blue-800' : 'text-purple-800'}`}>{turno.agente}</p>
                  <p className="text-gray-600">{formatFecha(turno.fecha)}</p>
                  <p className="text-gray-600">{formatH(turno.turno_inicio)}–{formatH(turno.turno_fin)}</p>
                  {turno.linea_atencion && <p className="text-gray-400">{turno.linea_atencion}</p>}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
              <ArrowLeftRight className="w-3.5 h-3.5"/> Los agentes quedarán intercambiados en esas fechas
            </div>

            {gestionExito ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle className="w-7 h-7 text-green-600" />
                </div>
                <p className="text-sm font-semibold text-green-700">¡Intercambio aplicado correctamente!</p>
                <p className="text-xs text-gray-400">Cerrando en un momento…</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs font-medium text-gray-700 block mb-1">Motivo <span className="text-gray-400">(opcional)</span></label>
                  <textarea value={gestionMotivo} onChange={e => setGMotivo(e.target.value)} rows={2}
                    placeholder="Ej: cubrimiento por incapacidad, ajuste de programación…"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"/>
                </div>

                {gestionProgreso !== null && (
                  <div className="space-y-1.5">
                    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-primary-500 rounded-full transition-all duration-300"
                        style={{ width: `${gestionProgreso}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 text-center">
                      {gestionProgreso < 60
                        ? 'Guardando en base de datos…'
                        : 'Actualizando vista…'
                      } {gestionProgreso}%
                    </p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button onClick={() => setGModal(null)} disabled={gestionGuardando}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-40">
                    Cancelar
                  </button>
                  <button onClick={handleIntercambioDirecto} disabled={gestionGuardando}
                    className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2">
                    <ArrowLeftRight className="w-4 h-4"/>
                    {gestionGuardando ? 'Aplicando…' : 'Confirmar intercambio'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal editar / crear turno */}
      {turnoEditar && (
        <EditarTurnoModal
          turno={turnoEditar}
          lineasDisponibles={lineas}
          onClose={() => setTE(null)}
          scriptUrl={scriptUrl}
          scriptSecret={scriptSecret}
          onGuardado={() => { setTE(null); cargar() }}
        />
      )}

      {/* Modal rechazo */}
      {rechazarModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-gray-900">{t('turnos.motivoRechazo')}</h3>
            <textarea value={motivoRechazo} onChange={e => setMotR(e.target.value)} rows={3}
              placeholder={t('turnos.motivoRechazoPlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"/>
            <div className="flex gap-3">
              <button onClick={() => { setRM(null); setMotR('') }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">{t('common.cancelar')}</button>
              <button onClick={handleRechazarConfirm} disabled={procesando === rechazarModal.id}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {t('turnos.confirmarRechazo')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
