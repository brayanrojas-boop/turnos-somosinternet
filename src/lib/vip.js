import { supabase } from './supabase'
import { notificarCasoCreado } from './slack'

// ── Helpers ────────────────────────────────────────────────────────────────
export function hoyISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// ── Productividad rápida (para dashboard) ─────────────────────────────────
export async function getProductividadMes() {
  const inicio = new Date()
  inicio.setDate(1); inicio.setHours(0, 0, 0, 0)
  const { data } = await supabase
    .from('vip_casos')
    .select('created_at, resuelto_at')
    .in('estado', ['Resuelto', 'Cerrado'])
    .not('resuelto_at', 'is', null)
    .gte('created_at', inicio.toISOString())
  const tiempos = (data ?? [])
    .map(c => (new Date(c.resuelto_at) - new Date(c.created_at)) / 60000)
    .filter(t => t > 0)
    .sort((a, b) => a - b)
  const pct = p => tiempos.length
    ? tiempos[Math.max(0, Math.ceil((p / 100) * tiempos.length) - 1)]
    : null
  return {
    p50: pct(50),
    p80: pct(80),
    total: tiempos.length,
    avg: tiempos.length ? tiempos.reduce((s, t) => s + t, 0) / tiempos.length : null,
  }
}

// ── Turnos ─────────────────────────────────────────────────────────────────
export async function getTurnos() {
  const { data } = await supabase
    .from('vip_turnos')
    .select('*')
    .eq('activo', true)
    .order('dia_semana')
    .order('hora_inicio')
  return data ?? []
}

export async function saveTurno(turno) {
  if (turno.id) {
    const { error } = await supabase.from('vip_turnos').update(turno).eq('id', turno.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from('vip_turnos').insert(turno)
    if (error) throw new Error(error.message)
  }
}

export async function deleteTurno(id) {
  await supabase.from('vip_turnos').update({ activo: false }).eq('id', id)
}

// Encuentra el analista en turno con menos casos activos (balanceo de carga)
export async function getAnalistaEnTurno() {
  const ahora = new Date()
  const hoy = hoyISO()
  const horaActual = ahora.toTimeString().slice(0, 5)

  // Obtener todos los analistas en turno ahora
  let candidatos = []

  const [{ data: progHoy }, { data: progAyer }] = await Promise.all([
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', hoy)
      .ilike('linea_atencion', 'especializado')
      .not('turno_inicio', 'is', null),
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', _ayerISO())
      .ilike('linea_atencion', 'especializado')
      .not('turno_inicio', 'is', null),
  ])

  const enTurno = []
  for (const t of (progHoy ?? [])) {
    if (!t.turno_inicio || !t.turno_fin) continue
    const esTrasnoche = t.turno_fin < t.turno_inicio
    if (esTrasnoche ? t.turno_inicio <= horaActual : (t.turno_inicio <= horaActual && t.turno_fin >= horaActual))
      enTurno.push(t)
  }
  for (const t of (progAyer ?? [])) {
    if (t.turno_fin && t.turno_inicio && t.turno_fin < t.turno_inicio && t.turno_fin >= horaActual)
      enTurno.push(t)
  }

  if (enTurno.length) {
    candidatos = enTurno.map(p => ({ analista_id: null, analista_nombre: p.agente }))
  } else {
    const { data } = await supabase
      .from('vip_turnos')
      .select('*')
      .eq('dia_semana', ahora.getDay())
      .eq('activo', true)
      .lte('hora_inicio', horaActual)
      .gte('hora_fin', horaActual)
    candidatos = data ?? []
  }

  if (candidatos.length === 0) return null
  if (candidatos.length === 1) return candidatos[0]

  // Elegir al analista con menos casos activos
  const { data: casosActivos } = await supabase
    .from('vip_casos')
    .select('asignado_a_nombre')
    .in('estado', ['Nuevo', 'Asignado', 'En gestión'])

  const conteo = {}
  for (const c of casosActivos ?? []) {
    const nombre = c.asignado_a_nombre
    if (nombre) conteo[nombre] = (conteo[nombre] ?? 0) + 1
  }

  return candidatos.reduce((min, a) =>
    (conteo[a.analista_nombre] ?? 0) < (conteo[min.analista_nombre] ?? 0) ? a : min
  )
}

function _ayerISO() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// Todos los agentes en turno en este momento (para el widget)
export async function getAgentesEnTurnoAhora() {
  const ahora = new Date()
  const horaActual = ahora.toTimeString().slice(0, 5)

  const [{ data: hoy, error: e1 }, { data: ayer, error: e2 }] = await Promise.all([
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', hoyISO())
      .ilike('linea_atencion', 'especializado')
      .not('turno_inicio', 'is', null)
      .order('agente'),
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', _ayerISO())
      .ilike('linea_atencion', 'especializado')
      .not('turno_inicio', 'is', null)
      .order('agente'),
  ])

  const resultado = []

  for (const t of (hoy ?? [])) {
    if (!t.turno_inicio || !t.turno_fin) continue
    const esTrasnoche = t.turno_fin < t.turno_inicio
    if (esTrasnoche) {
      if (t.turno_inicio <= horaActual) resultado.push(t)
    } else {
      if (t.turno_inicio <= horaActual && t.turno_fin >= horaActual) resultado.push(t)
    }
  }

  for (const t of (ayer ?? [])) {
    if (!t.turno_inicio || !t.turno_fin) continue
    if (t.turno_fin < t.turno_inicio && t.turno_fin >= horaActual) resultado.push(t)
  }

  return resultado
}

// Agentes en turno para cualquier línea (SARA, RETENCIÓN, Especializado…)
export async function getAgentesEnTurnoLinea(linea) {
  const ahora = new Date()
  const horaActual = ahora.toTimeString().slice(0, 5)

  const [{ data: hoy }, { data: ayer }] = await Promise.all([
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', hoyISO())
      .ilike('linea_atencion', linea)
      .not('turno_inicio', 'is', null)
      .order('agente'),
    supabase.from('vip_turnos_programados')
      .select('agente, turno_inicio, turno_fin')
      .eq('fecha', _ayerISO())
      .ilike('linea_atencion', linea)
      .not('turno_inicio', 'is', null)
      .order('agente'),
  ])

  const resultado = []
  for (const t of (hoy ?? [])) {
    if (!t.turno_inicio || !t.turno_fin) continue
    const esTrasnoche = t.turno_fin < t.turno_inicio
    if (esTrasnoche ? t.turno_inicio <= horaActual : (t.turno_inicio <= horaActual && t.turno_fin >= horaActual))
      resultado.push(t)
  }
  for (const t of (ayer ?? [])) {
    if (t.turno_fin && t.turno_inicio && t.turno_fin < t.turno_inicio && t.turno_fin >= horaActual)
      resultado.push(t)
  }
  return resultado
}

// ── Turnos programados (planilla Google Sheets) ────────────────────────────
export async function getTurnosProgramados(fecha) {
  let q = supabase
    .from('vip_turnos_programados')
    .select('*')
    .ilike('linea_atencion', 'especializado')
    .order('turno_inicio')
  if (fecha) q = q.eq('fecha', fecha)
  const { data } = await q
  return data ?? []
}

function _parsearCSV(texto) {
  return texto.replace(/\r/g, '').split('\n').filter(l => l.trim()).map(linea => {
    const cols = []
    let actual = '', enComillas = false
    for (const ch of linea) {
      if (ch === '"') { enComillas = !enComillas; continue }
      if ((ch === ',' || ch === '\t') && !enComillas) { cols.push(actual.trim()); actual = ''; continue }
      actual += ch
    }
    cols.push(actual.trim())
    return cols
  })
}

function _hora(val) {
  if (!val || val.trim() === '' || val.trim() === '-') return null
  const s = val.trim()
  // Formato datetime: "2026-06-21 14:00:00" → extraer solo la hora
  const dt = s.match(/\d{4}-\d{2}-\d{2}[T\s](\d{1,2}):(\d{2})/)
  if (dt) {
    const h = dt[1].padStart(2, '0'), m = dt[2]
    if (h === '00' && m === '00') return null // Sheets exporta celdas vacías como 0:00:00
    return `${h}:${m}`
  }
  // Formato hora plana: "14:00" o "14:00:00"
  const m = s.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const hh = m[1].padStart(2, '0'), mm = m[2]
  if (hh === '00' && mm === '00') return null // ídem para formato plano
  return `${hh}:${mm}`
}

function _numero(val) {
  if (!val || val.trim() === '' || val.trim() === '-') return null
  const m = val.trim().match(/^(\d+):(\d{2})$/)
  if (m) return Math.round((parseInt(m[1]) + parseInt(m[2]) / 60) * 100) / 100
  const n = parseFloat(val.replace(',', '.'))
  return isNaN(n) ? null : n
}

function _fecha(val) {
  if (!val || val.trim() === '') return null
  const s = val.trim()
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return null
}

function _sheetACsvUrl(url) {
  if (url.includes('/pub?') || url.includes('output=csv')) return url
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (!m) throw new Error('URL no válida. Copia el link desde tu Google Sheet.')
  return `https://docs.google.com/spreadsheets/d/${m[1]}/pub?output=csv`
}

export async function importarTurnosDesdeSheet(url) {
  const csvUrl = _sheetACsvUrl(url.trim())

  let res
  try {
    const urlConCache = `${csvUrl}${csvUrl.includes('?') ? '&' : '?'}_cb=${Date.now()}`
    res = await fetch(urlConCache, { cache: 'no-store' })
  } catch {
    throw new Error('No se pudo conectar con Google Sheets. Verifica tu conexión y que el Sheet esté publicado.')
  }
  if (!res.ok) throw new Error(`Error ${res.status}. Asegúrate de publicar el Sheet: Archivo → Compartir → Publicar en la web → CSV.`)

  const texto = await res.text()
  const filas = _parsearCSV(texto)
  if (filas.length < 2) throw new Error('No hay datos en el Sheet.')

  const enc = filas[0].map(h => h.toLowerCase().trim())
  const col = h => enc.indexOf(h)
  const emailIdx = enc.indexOf('email')

  const registros = []
  for (let i = 1; i < filas.length; i++) {
    const v = filas[i]
    if (!v[col('agente')]?.trim() && !_fecha(v[col('fecha')])) continue
    registros.push({
      fecha:             _fecha(v[col('fecha')]),
      dia_semana:        v[col('dia_semana')]?.trim() || null,
      linea_atencion:    v[col('linea_atencion')]?.trim() || null,
      agente:            v[col('agente')]?.trim() || null,
      novedad:           v[col('novedad')]?.trim() || null,
      turno_inicio:      _hora(v[col('turno_inicio')]),
      turno_fin:         _hora(v[col('turno_fin')]),
      break_inicio:      _hora(v[col('break_inicio')]),
      break_fin:         _hora(v[col('break_fin')]),
      lunch_inicio:      _hora(v[col('lunch_inicio')]),
      lunch_fin:         _hora(v[col('lunch_fin')]),
      horas_programadas: _numero(v[col('horas_programadas')]),
      entrada:           _hora(v[col('entrada')]),
      hd:                _numero(v[col('hd')]),
      hn:                _numero(v[col('hn')]),
      hdf:               _numero(v[col('hdf')]),
      hnf:               _numero(v[col('hnf')]),
      hed:               _numero(v[col('hed')]),
      hen:               _numero(v[col('hen')]),
      hedf:              _numero(v[col('hedf')]),
      henf:              _numero(v[col('henf')]),
      tipo_turno:        v[col('tipo turno')]?.trim() || null,
      hd_:               _numero(v[col('hd_')]),
      hn_:               _numero(v[col('hn_')]),
      ...(emailIdx >= 0 ? { email: v[emailIdx]?.trim() || null } : {}),
    })
  }

  if (registros.length === 0) throw new Error('No se encontraron filas con datos válidos.')

  // Re-import idempotente: borra fechas existentes antes de insertar
  const fechas = [...new Set(registros.map(r => r.fecha).filter(Boolean))]
  if (fechas.length > 0) {
    // Borrar en lotes para evitar límite de PostgREST con muchas fechas
    const CHUNK_DEL = 100
    for (let i = 0; i < fechas.length; i += CHUNK_DEL) {
      const { error: delErr } = await supabase
        .from('vip_turnos_programados')
        .delete()
        .in('fecha', fechas.slice(i, i + CHUNK_DEL))
      if (delErr) throw new Error(delErr.message)
    }
  }

  // Insertar en lotes de 500 para respetar el límite de PostgREST
  const CHUNK = 500
  let insertados = 0
  for (let i = 0; i < registros.length; i += CHUNK) {
    const { error } = await supabase
      .from('vip_turnos_programados')
      .insert(registros.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
    insertados += Math.min(CHUNK, registros.length - i)
  }

  return insertados
}

// ── Clientes VIP ───────────────────────────────────────────────────────────
export async function buscarClienteVip(documento) {
  const { data } = await supabase
    .from('vip_clientes')
    .select('*')
    .eq('documento', documento.trim())
    .single()
  return data ?? null
}

export async function upsertClienteVip({ documento, nombre, codigo, telefono }) {
  const { error } = await supabase
    .from('vip_clientes')
    .upsert({ documento, nombre, codigo: codigo ?? '', telefono: telefono ?? '', updated_at: new Date().toISOString() }, { onConflict: 'documento' })
  if (error) throw new Error(error.message)
}

// ── Casos ──────────────────────────────────────────────────────────────────
export async function getCasos(filtros = {}) {
  let q = supabase
    .from('vip_casos')
    .select('*')
    .order('created_at', { ascending: false })

  if (filtros.estado) q = q.eq('estado', filtros.estado)
  if (filtros.asignado_a) q = q.eq('asignado_a', filtros.asignado_a)
  if (filtros.fechaDesde) q = q.gte('created_at', filtros.fechaDesde)
  if (filtros.fechaHasta) q = q.lte('created_at', filtros.fechaHasta + 'T23:59:59')

  const { data } = await q
  return data ?? []
}

export async function reabrirCaso(casoId, motivo, autorNombre, autorRol) {
  const { error } = await supabase
    .from('vip_casos')
    .update({ estado: 'En gestión', resuelto_at: null })
    .eq('id', casoId)
  if (error) throw new Error(error.message)

  await addMensajeHilo(casoId, {
    autor_nombre: autorNombre,
    autor_rol: autorRol,
    mensaje: `Caso reabierto. Motivo: ${motivo}`,
    tipo: 'sistema',
  })
}

export async function getCaso(id) {
  const { data } = await supabase.from('vip_casos').select('*').eq('id', id).single()
  return data
}

export async function crearCaso(caso, creadoPorPerfil) {
  // Guardar/actualizar cliente si tiene documento
  if (caso.cliente_documento?.trim()) {
    await upsertClienteVip({
      documento: caso.cliente_documento.trim(),
      nombre:    caso.cliente_nombre,
      codigo:    caso.cliente_codigo,
      telefono:  caso.telefono,
    })
  }

  // Buscar analista en turno
  const turno = await getAnalistaEnTurno()

  const nuevoCaso = {
    cliente_documento: caso.cliente_documento?.trim() || null,
    cliente_nombre:   caso.cliente_nombre,
    cliente_codigo:   caso.cliente_codigo ?? '',
    telefono:         caso.telefono ?? '',
    tipo_problema:    caso.tipo_problema,
    descripcion:      caso.descripcion ?? '',
    prioridad:        caso.prioridad ?? 'Alta',
    estado:           turno ? 'Asignado' : 'Nuevo',
    creado_por:       creadoPorPerfil.id,
    creado_por_nombre: creadoPorPerfil.full_name,
    asignado_a:       turno?.analista_id ?? null,
    asignado_a_nombre: turno?.analista_nombre ?? null,
  }

  const { data, error } = await supabase.from('vip_casos').insert(nuevoCaso).select().single()
  if (error) throw new Error(error.message)

  // Mensaje inicial en el hilo
  const msgSistema = turno
    ? `Caso creado y asignado automáticamente a **${turno.analista_nombre}** según turno activo.`
    : 'Caso creado. No hay analista en turno activo — pendiente de asignación manual.'

  await addMensajeHilo(data.id, {
    autor_nombre: 'Sistema',
    autor_rol: 'sistema',
    mensaje: msgSistema,
    tipo: 'asignacion',
  })

  // Notificaciones Slack (no bloquea la creación del caso si falla)
  if (turno?.analista_nombre) {
    const { data: mapping } = await supabase
      .from('vip_slack_usuarios')
      .select('slack_user_id')
      .eq('analista_nombre', turno.analista_nombre)
      .single()
    notificarCasoCreado(data, mapping?.slack_user_id ?? null).catch(() => {})
  } else {
    notificarCasoCreado(data, null).catch(() => {})
  }

  return data
}

export async function asignarCaso(casoId, analistaId, analistaNombre, asignadoPorNombre) {
  const { error } = await supabase.from('vip_casos').update({
    asignado_a: analistaId,
    asignado_a_nombre: analistaNombre,
    estado: 'Asignado',
  }).eq('id', casoId)
  if (error) throw new Error(error.message)

  await addMensajeHilo(casoId, {
    autor_nombre: asignadoPorNombre,
    autor_rol: 'supervisor',
    mensaje: `Caso reasignado a **${analistaNombre}**.`,
    tipo: 'asignacion',
  })
}

export async function reasignarCasoVip(casoId, analistaNombre, asignadoPorNombre) {
  const { data: perfil } = await supabase.from('profiles')
    .select('id, full_name')
    .ilike('full_name', analistaNombre)
    .maybeSingle()
  const analistaId = perfil?.id ?? analistaNombre
  const nombreFinal = perfil?.full_name ?? analistaNombre
  await asignarCaso(casoId, analistaId, nombreFinal, asignadoPorNombre)
}

export async function actualizarEstado(casoId, estado, autorNombre, autorRol) {
  const update = { estado }
  if (estado === 'Resuelto' || estado === 'Cerrado') update.resuelto_at = new Date().toISOString()

  const { error } = await supabase.from('vip_casos').update(update).eq('id', casoId)
  if (error) throw new Error(error.message)

  await addMensajeHilo(casoId, {
    autor_nombre: autorNombre,
    autor_rol: autorRol,
    mensaje: `Estado actualizado a **${estado}**.`,
    tipo: estado === 'Resuelto' || estado === 'Cerrado' ? 'cierre' : 'sistema',
  })
}

// ── Hilo ───────────────────────────────────────────────────────────────────
export async function getHilo(casoId) {
  const { data } = await supabase
    .from('vip_hilo')
    .select('*')
    .eq('caso_id', casoId)
    .order('created_at', { ascending: true })
  return data ?? []
}

export async function addMensajeHilo(casoId, { autor_id, autor_nombre, autor_rol, mensaje, tipo = 'update', adjuntos }) {
  const row = {
    caso_id: casoId,
    autor_id: autor_id ?? null,
    autor_nombre,
    autor_rol,
    mensaje,
    tipo,
  }
  if (adjuntos?.length) row.adjuntos = adjuntos
  const { error } = await supabase.from('vip_hilo').insert(row)
  if (error) throw new Error(error.message)
}

// ── Reporte de productividad ───────────────────────────────────────────────
export async function getReporteProductividad(desde, hasta) {
  let q = supabase
    .from('vip_casos')
    .select('asignado_a_nombre, estado, created_at, resuelto_at')
    .not('asignado_a_nombre', 'is', null)

  if (desde) q = q.gte('created_at', desde)
  if (hasta) q = q.lte('created_at', hasta + 'T23:59:59')

  const { data, error } = await q
  if (error) throw new Error(error.message)
  const casos = data ?? []

  const map = {}
  for (const c of casos) {
    const nombre = c.asignado_a_nombre
    if (!map[nombre]) map[nombre] = { nombre, total: 0, activos: 0, cerrados: 0, tiempos: [] }
    const a = map[nombre]
    a.total++
    if (['Nuevo', 'Asignado', 'En gestión'].includes(c.estado)) a.activos++
    if (['Resuelto', 'Cerrado'].includes(c.estado)) {
      a.cerrados++
      if (c.resuelto_at && c.created_at)
        a.tiempos.push((new Date(c.resuelto_at) - new Date(c.created_at)) / 60000)
    }
  }

  return Object.values(map).map(({ tiempos, ...a }) => ({
    ...a,
    avg_mins: tiempos.length ? Math.round(tiempos.reduce((s, t) => s + t, 0) / tiempos.length) : null,
    min_mins: tiempos.length ? Math.round(Math.min(...tiempos)) : null,
    max_mins: tiempos.length ? Math.round(Math.max(...tiempos)) : null,
  })).sort((a, b) => b.cerrados - a.cerrados)
}

// ── Seguimiento ───────────────────────────────────────────────────────────
export async function guardarSeguimiento(casoId, { fechaISO, notas, autorNombre }) {
  const seguimiento_en = new Date(fechaISO).toISOString()
  const { error } = await supabase
    .from('vip_casos')
    .update({ seguimiento_en, seguimiento_por_nombre: autorNombre, seguimiento_notas: notas || null })
    .eq('id', casoId)
  if (error) throw new Error(error.message)
  const d = new Date(fechaISO)
  const p = n => String(n).padStart(2, '0')
  const label = `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
  await addMensajeHilo(casoId, {
    autor_nombre: autorNombre,
    autor_rol: 'sistema',
    mensaje: `Seguimiento programado para **${label}**${notas ? ': ' + notas : ''}.`,
    tipo: 'sistema',
  })
}

export async function cancelarSeguimiento(casoId, autorNombre) {
  const { error } = await supabase
    .from('vip_casos')
    .update({ seguimiento_en: null, seguimiento_por_nombre: null, seguimiento_notas: null })
    .eq('id', casoId)
  if (error) throw new Error(error.message)
  await addMensajeHilo(casoId, {
    autor_nombre: autorNombre,
    autor_rol: 'sistema',
    mensaje: 'Seguimiento cancelado.',
    tipo: 'sistema',
  })
}

// ── Tipificación de casos ─────────────────────────────────────────────────
export async function guardarTipificacion(casoId, { razon_contacto, causa_raiz, solucion, escalado, escalado_a, escalado_canal, escalado_link }) {
  const { error } = await supabase
    .from('vip_casos')
    .update({
      razon_contacto: razon_contacto || null,
      causa_raiz: causa_raiz || null,
      solucion: solucion || null,
      escalado: !!escalado,
      escalado_a: escalado ? (escalado_a || null) : null,
      escalado_canal: escalado ? (escalado_canal || null) : null,
      escalado_link: escalado ? (escalado_link || null) : null,
    })
    .eq('id', casoId)
  if (error) throw new Error(error.message)
}

// ── Historial de cliente ──────────────────────────────────────────────────
export async function getCasosHistoricoCliente(clienteNombre, clienteDocumento, excludeId) {
  let q = supabase
    .from('vip_casos')
    .select('id, numero, estado, tipo_problema, created_at, resuelto_at, asignado_a_nombre, prioridad')
    .neq('id', excludeId)
    .order('created_at', { ascending: false })
    .limit(8)
  q = clienteDocumento ? q.eq('cliente_documento', clienteDocumento) : q.ilike('cliente_nombre', clienteNombre)
  const { data } = await q
  return data ?? []
}

// ── Auditoría de exportaciones ─────────────────────────────────────────────
export async function registrarExportacion({ usuarioId, usuarioNombre, usuarioEmail, reporte, filtros, totalRegistros }) {
  const hace1h = new Date(Date.now() - 3600000).toISOString()
  const { count } = await supabase
    .from('vip_exportaciones_log')
    .select('*', { count: 'exact', head: true })
    .eq('usuario_id', usuarioId)
    .gte('created_at', hace1h)
  if (count >= 10) throw new Error('Límite de exportaciones alcanzado (10/hora). Intenta más tarde.')
  const { error } = await supabase
    .from('vip_exportaciones_log')
    .insert({ usuario_id: usuarioId, usuario_nombre: usuarioNombre, usuario_email: usuarioEmail, reporte, filtros, total_registros: totalRegistros })
  if (error) throw new Error('Error al registrar exportación: ' + error.message)
}

export async function getExportacionesLog() {
  const { data } = await supabase
    .from('vip_exportaciones_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  return data ?? []
}

// ── Notificaciones en app ──────────────────────────────────────────────────
export async function crearNotificacion({ usuarioId, tipo, titulo, mensaje, casoId, casoNumero }) {
  if (!usuarioId) return
  await supabase.from('vip_notificaciones').insert({
    usuario_id: usuarioId, tipo, titulo,
    mensaje: mensaje ?? null, caso_id: casoId ?? null, caso_numero: casoNumero ?? null,
  })
}

export async function notificarSupervisores({ tipo, titulo, mensaje, casoId, casoNumero, excludeId }) {
  const { data: sups } = await supabase.from('profiles').select('id').in('role', ['admin', 'supervisor'])
  const notifs = (sups ?? [])
    .filter(s => s.id !== excludeId)
    .map(s => ({ usuario_id: s.id, tipo, titulo, mensaje: mensaje ?? null, caso_id: casoId ?? null, caso_numero: casoNumero ?? null }))
  if (notifs.length) await supabase.from('vip_notificaciones').insert(notifs)
}

export async function getNotificaciones() {
  const { data } = await supabase
    .from('vip_notificaciones')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30)
  return data ?? []
}

export async function marcarTodasLeidas() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  await supabase.from('vip_notificaciones').update({ leida: true }).eq('usuario_id', user.id).eq('leida', false)
}

export function suscribirNotificaciones(usuarioId, callback) {
  const channel = supabase
    .channel(`notifs-${usuarioId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'vip_notificaciones', filter: `usuario_id=eq.${usuarioId}` },
      payload => callback(payload.new)
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// ── Reporte completo ──────────────────────────────────────────────────────
function isoLocalDia(fechaStr, fin = false) {
  const offsetMin = new Date().getTimezoneOffset()
  const sign = offsetMin > 0 ? '-' : '+'
  const h = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')
  const m = String(Math.abs(offsetMin) % 60).padStart(2, '0')
  return `${fechaStr}${fin ? 'T23:59:59' : 'T00:00:00'}${sign}${h}:${m}`
}

export async function getCasosReporte(desde, hasta) {
  const CAMPOS = 'id, numero, created_at, resuelto_at, estado, cliente_documento, cliente_nombre, asignado_a_nombre, razon_contacto, causa_raiz, solucion, escalado, tipo_problema'
  const [{ data: enRango, error: e1 }, { data: activos, error: e2 }] = await Promise.all([
    supabase.from('vip_casos').select(CAMPOS)
      .gte('created_at', isoLocalDia(desde))
      .lte('created_at', isoLocalDia(hasta, true))
      .order('created_at'),
    supabase.from('vip_casos').select(CAMPOS)
      .not('estado', 'in', '(Resuelto,Cerrado)')
      .order('created_at'),
  ])
  if (e1) throw new Error(e1.message)
  if (e2) throw new Error(e2.message)
  const vistos = new Set()
  const data = []
  for (const c of [...(enRango ?? []), ...(activos ?? [])]) {
    if (!vistos.has(c.id)) { vistos.add(c.id); data.push(c) }
  }
  return data.sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export async function getHistorialEstados(casoIds) {
  if (!casoIds.length) return {}
  const { data } = await supabase
    .from('vip_hilo')
    .select('caso_id, mensaje, created_at')
    .in('caso_id', casoIds)
    .in('tipo', ['sistema', 'cierre'])
    .ilike('mensaje', 'Estado actualizado a%')
    .order('created_at', { ascending: true })
  const porCaso = {}
  for (const msg of data ?? []) {
    if (!porCaso[msg.caso_id]) porCaso[msg.caso_id] = []
    const match = msg.mensaje.match(/\*\*(.+?)\*\*/)
    if (match) porCaso[msg.caso_id].push({ estado: match[1], at: msg.created_at })
  }
  return porCaso
}

// ── Configuración global (vip_config) ────────────────────────────────────

export async function getVipConfig() {
  try {
    const { data } = await supabase.from('vip_config').select('key, value')
    if (!data) return {}
    return Object.fromEntries(data.map(r => [r.key, r.value ?? '']))
  } catch { return {} }
}

export async function setVipConfig(updates) {
  const rows = Object.entries(updates).map(([key, value]) => ({ key, value: value || null }))
  const { error } = await supabase.from('vip_config').upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(error.message)
}

// Busca nombres de agentes que contengan el texto dado (para autocompletado)
export async function buscarNombresAgente(texto) {
  if (!texto || texto.length < 2) return []
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('agente')
    .ilike('agente', `%${texto}%`)
    .not('agente', 'is', null)
    .limit(50)
  return [...new Set((data ?? []).map(r => r.agente).filter(Boolean))].sort()
}

// Busca el nombre exacto del analista en el Sheet comparando con su full_name del perfil.
// Retorna el nombre tal como está en la columna agente, o null si no hay coincidencia segura.
export async function autoDetectarNombreTurno(fullName) {
  if (!fullName) return null
  const { data: exacto } = await supabase
    .from('vip_turnos_programados').select('agente').ilike('agente', fullName).limit(1).maybeSingle()
  if (exacto?.agente) return exacto.agente
  const palabras = fullName.trim().split(/\s+/).filter(p => p.length > 3)
  if (palabras.length < 2) return null
  let q = supabase.from('vip_turnos_programados').select('agente').not('agente', 'is', null)
  for (const p of palabras.slice(0, 2)) q = q.ilike('agente', `%${p}%`)
  const { data } = await q.limit(10)
  if (!data?.length) return null
  if (data.length === 1) return data[0].agente
  const profWords = fullName.toLowerCase().split(/\s+/)
  let best = null, bestScore = 0
  for (const row of data) {
    const agWords = row.agente.toLowerCase().split(/\s+/)
    const score = profWords.filter(w => agWords.some(a => a.includes(w) || w.includes(a))).length
    if (score > bestScore) { bestScore = score; best = row.agente }
  }
  return bestScore >= 2 ? best : null
}

export async function guardarNombreTurnoEnPerfil(userId, nombreTurno) {
  const { error } = await supabase.from('profiles').update({ nombre_turno: nombreTurno }).eq('id', userId)
  if (error) throw new Error(error.message)
}

// ── Cambios de turno ──────────────────────────────────────────────────────

export async function getMisTurnos(nombre) {
  if (!nombre) return []
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('*')
    .ilike('agente', nombre)
    .gte('fecha', hoyISO())
    .order('fecha')
  return data ?? []
}

export async function getTurnosAnalista(nombre, desde, hasta) {
  if (!nombre) return []
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('*')
    .ilike('agente', nombre)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha')
  return data ?? []
}

export async function getTodosAnalistasActivos(desde, hasta) {
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('agente')
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .not('agente', 'is', null)
  const nombres = [...new Set((data ?? []).map(r => r.agente).filter(Boolean))].sort()
  return nombres
}

export async function getTurnosSemana(inicio, fin) {
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('*')
    .gte('fecha', inicio)
    .lte('fecha', fin)
    .not('agente', 'is', null)
    .order('fecha')
    .order('turno_inicio', { nullsFirst: false })
  return data ?? []
}

export async function getTurnosFuturos() {
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('*')
    .gte('fecha', hoyISO())
    .not('agente', 'is', null)
    .not('turno_inicio', 'is', null)
    .order('fecha')
    .order('agente')
  return data ?? []
}

export async function crearSolicitudCambio({ solicitanteNombre, receptorNombre, turnoSol, turnoRec, motivo }) {
  const { data, error } = await supabase
    .from('vip_cambios_turno')
    .insert({
      solicitante_nombre: solicitanteNombre,
      receptor_nombre: receptorNombre,
      turno_sol_fecha: turnoSol.fecha,
      turno_sol_inicio: turnoSol.turno_inicio,
      turno_sol_fin: turnoSol.turno_fin,
      turno_rec_fecha: turnoRec.fecha,
      turno_rec_inicio: turnoRec.turno_inicio,
      turno_rec_fin: turnoRec.turno_fin,
      motivo: motivo ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function getSolicitudesCambio(nombre) {
  if (!nombre) return []
  const { data, error } = await supabase
    .from('vip_cambios_turno')
    .select('*')
    .or(`solicitante_nombre.ilike.${nombre},receptor_nombre.ilike.${nombre}`)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function responderSolicitudCambio(id, aceptar, motivoRechazo) {
  const { error } = await supabase
    .from('vip_cambios_turno')
    .update({ estado: aceptar ? 'aceptado' : 'rechazado', motivo_rechazo: motivoRechazo ?? null, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

function _addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function _horasEntre(fechaFin, horaFin, fechaInicio, horaInicio) {
  const fin    = new Date(`${fechaFin}T${String(horaFin).slice(0, 5)}:00`)
  const inicio = new Date(`${fechaInicio}T${String(horaInicio).slice(0, 5)}:00`)
  return (inicio - fin) / 3600000
}

// Verifica que el analista tenga ≥12h de descanso al tomar la fechaNueva con el horario dado.
// excluirFecha: fecha de turno que el analista está cediendo (se ignora en la búsqueda).
export async function validarDescanso12h(analistaNombre, fechaNueva, inicioNuevo, finNuevo, excluirFecha) {
  if (!inicioNuevo || !finNuevo) return { ok: true }
  const ayer   = _addDays(fechaNueva, -1)
  const manana = _addDays(fechaNueva, 1)
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('fecha, turno_inicio, turno_fin')
    .ilike('agente', analistaNombre)
    .in('fecha', [ayer, manana])
  for (const t of (data ?? [])) {
    if (t.fecha === excluirFecha || !t.turno_inicio || !t.turno_fin) continue
    if (t.fecha === ayer) {
      const horas = _horasEntre(ayer, t.turno_fin, fechaNueva, inicioNuevo)
      if (horas < 12) return { ok: false, analista: analistaNombre, horas: Math.round(horas * 10) / 10 }
    }
    if (t.fecha === manana) {
      const horas = _horasEntre(fechaNueva, finNuevo, manana, t.turno_inicio)
      if (horas < 12) return { ok: false, analista: analistaNombre, horas: Math.round(horas * 10) / 10 }
    }
  }
  return { ok: true }
}

// Cuando el receptor acepta, aplica el intercambio automáticamente si se cumplen las 12h.
// Retorna { ok: true, cambio } o { ok: false, motivo }.
export async function autoAplicarCambioAceptado(cambioId) {
  const { data: cambio, error: ce } = await supabase
    .from('vip_cambios_turno').select('*').eq('id', cambioId).single()
  if (ce || !cambio) throw new Error('Solicitud no encontrada')

  const [chkA, chkB] = await Promise.all([
    validarDescanso12h(cambio.solicitante_nombre, cambio.turno_rec_fecha, cambio.turno_rec_inicio, cambio.turno_rec_fin, cambio.turno_sol_fecha),
    validarDescanso12h(cambio.receptor_nombre, cambio.turno_sol_fecha, cambio.turno_sol_inicio, cambio.turno_sol_fin, cambio.turno_rec_fecha),
  ])
  if (!chkA.ok) return { ok: false, motivo: `${cambio.solicitante_nombre} quedaría con solo ${chkA.horas}h de descanso (mínimo 12h requeridas).` }
  if (!chkB.ok) return { ok: false, motivo: `${cambio.receptor_nombre} quedaría con solo ${chkB.horas}h de descanso (mínimo 12h requeridas).` }

  // Intercambiar TODAS las filas de cada persona en su fecha (turno + descanso)
  const [{ data: filasA }, { data: filasB }] = await Promise.all([
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_sol_fecha).ilike('agente', cambio.solicitante_nombre),
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_rec_fecha).ilike('agente', cambio.receptor_nombre),
  ])
  if (!filasA?.length || !filasB?.length) return { ok: false, motivo: 'No se encontraron los turnos en la base de datos.' }

  await Promise.all([
    ...filasA.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.receptor_nombre }).eq('id', r.id)),
    ...filasB.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.solicitante_nombre }).eq('id', r.id)),
  ])
  await supabase.from('vip_cambios_turno').update({
    estado: 'aprobado', aprobado_por: 'auto', updated_at: new Date().toISOString(),
  }).eq('id', cambioId)
  return { ok: true, cambio }
}

// Aplica el intercambio sin verificar las 12h de descanso (cuando el usuario elige ignorar la advertencia).
export async function forzarAplicarCambioAceptado(cambioId) {
  const { data: cambio, error: ce } = await supabase
    .from('vip_cambios_turno').select('*').eq('id', cambioId).single()
  if (ce || !cambio) throw new Error('Solicitud no encontrada')

  const [{ data: filasA }, { data: filasB }] = await Promise.all([
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_sol_fecha).ilike('agente', cambio.solicitante_nombre),
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_rec_fecha).ilike('agente', cambio.receptor_nombre),
  ])
  if (!filasA?.length || !filasB?.length) return { ok: false, motivo: 'No se encontraron los turnos en la base de datos.' }

  await Promise.all([
    ...filasA.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.receptor_nombre }).eq('id', r.id)),
    ...filasB.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.solicitante_nombre }).eq('id', r.id)),
  ])
  await supabase.from('vip_cambios_turno').update({
    estado: 'aprobado', aprobado_por: 'auto', updated_at: new Date().toISOString(),
  }).eq('id', cambioId)
  return { ok: true, cambio }
}

export async function cancelarSolicitudCambio(id) {
  const { error } = await supabase
    .from('vip_cambios_turno')
    .update({ estado: 'cancelado', updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function getCambiosAprobadosRecientes(supervisorNombre, dias = 7) {
  const desde = new Date(Date.now() - dias * 86400000).toISOString()
  const { data, error } = await supabase
    .from('vip_cambios_turno')
    .select('*')
    .eq('estado', 'aprobado')
    .eq('aprobado_por', supervisorNombre)
    .gte('updated_at', desde)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getSolicitudesPendientesSupervisor() {
  const { data, error } = await supabase
    .from('vip_cambios_turno')
    .select('*')
    .in('estado', ['pendiente', 'aceptado'])
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function aprobarCambio(id, supervisorNombre) {
  const { error } = await supabase
    .from('vip_cambios_turno')
    .update({ estado: 'aprobado', aprobado_por: supervisorNombre, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Adjuntos en hilo ──────────────────────────────────────────────────────
export async function uploadAdjunto(casoId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `casos/${casoId}/${Date.now()}_${safeName}`
  const { error } = await supabase.storage
    .from('vip-adjuntos')
    .upload(path, file, { cacheControl: '3600', upsert: false })
  if (error) throw new Error(error.message)
  const { data: { publicUrl } } = supabase.storage.from('vip-adjuntos').getPublicUrl(path)
  return { url: publicUrl, nombre: file.name, tipo: file.type, size: file.size }
}

// ── Ficha completa de cliente ─────────────────────────────────────────────
export async function getFichaCliente(documento, nombre) {
  let q = supabase
    .from('vip_casos')
    .select('id, numero, estado, tipo_problema, created_at, resuelto_at, asignado_a_nombre, prioridad, escalado, razon_contacto, causa_raiz')
    .order('created_at', { ascending: false })
  q = documento ? q.eq('cliente_documento', documento) : q.ilike('cliente_nombre', `%${nombre}%`)
  const { data } = await q
  const casos = data ?? []
  const cerrados = casos.filter(c => ['Resuelto', 'Cerrado'].includes(c.estado))
  const tiempos = cerrados
    .filter(c => c.resuelto_at && c.created_at)
    .map(c => (new Date(c.resuelto_at) - new Date(c.created_at)) / 60000)
  return {
    casos,
    stats: {
      total: casos.length,
      abiertos: casos.filter(c => !['Resuelto', 'Cerrado'].includes(c.estado)).length,
      cerrados: cerrados.length,
      escalados: casos.filter(c => c.escalado).length,
      avg_mins: tiempos.length ? Math.round(tiempos.reduce((s, t) => s + t, 0) / tiempos.length) : null,
    },
  }
}

// ── Dashboard de turno actual (supervisión) ───────────────────────────────
export async function getDashboardTurnoActual() {
  const agentes = await getAgentesEnTurnoAhora()
  if (!agentes.length) return []
  const nombres = agentes.map(a => a.agente)
  const { data: casos } = await supabase
    .from('vip_casos')
    .select('id, numero, asignado_a_nombre, estado, created_at, prioridad, cliente_nombre')
    .in('estado', ['Nuevo', 'Asignado', 'En gestión'])
    .in('asignado_a_nombre', nombres)
  return agentes.map(a => ({
    ...a,
    casos: (casos ?? [])
      .filter(c => c.asignado_a_nombre === a.agente)
      .sort((x, y) => new Date(x.created_at) - new Date(y.created_at)),
  }))
}

// ── Métricas detalladas por analista (supervisión) ─────────────────────────
export async function getMetricasDetalladas(desde, hasta) {
  let q = supabase
    .from('vip_casos')
    .select('asignado_a_nombre, estado, created_at, resuelto_at, escalado')
    .not('asignado_a_nombre', 'is', null)
  if (desde) q = q.gte('created_at', desde)
  if (hasta) q = q.lte('created_at', hasta + 'T23:59:59')
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const map = {}
  for (const c of data ?? []) {
    const n = c.asignado_a_nombre
    if (!map[n]) map[n] = { nombre: n, total: 0, activos: 0, cerrados: 0, escalados: 0, tiempos: [] }
    const a = map[n]
    a.total++
    if (['Nuevo', 'Asignado', 'En gestión'].includes(c.estado)) a.activos++
    if (['Resuelto', 'Cerrado'].includes(c.estado)) {
      a.cerrados++
      if (c.resuelto_at && c.created_at)
        a.tiempos.push((new Date(c.resuelto_at) - new Date(c.created_at)) / 60000)
    }
    if (c.escalado) a.escalados++
  }
  return Object.values(map).map(({ tiempos, ...a }) => ({
    ...a,
    avg_mins: tiempos.length ? Math.round(tiempos.reduce((s, t) => s + t, 0) / tiempos.length) : null,
    tasa_escalacion: a.total > 0 ? Math.round((a.escalados / a.total) * 100) : 0,
  })).sort((a, b) => b.cerrados - a.cerrados)
}

export async function rechazarCambioSupervisor(id, supervisorNombre, motivo) {
  const { error } = await supabase
    .from('vip_cambios_turno')
    .update({ estado: 'rechazado_supervisor', aprobado_por: supervisorNombre, motivo_rechazo: motivo, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function aplicarCambioEnSheet(url, secret, cambio) {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      secret,
      agente1: cambio.solicitante_nombre,
      fecha1: cambio.turno_sol_fecha,
      agente2: cambio.receptor_nombre,
      fecha2: cambio.turno_rec_fecha,
    }),
  })
  // Google Apps Script redirige por CORS — si respondió con 200 el script ejecutó OK.
  // Intentamos leer JSON pero si falla (respuesta opaca/HTML) lo consideramos éxito
  // porque los logs de Apps Script confirman que doPost se ejecuta correctamente.
  if (res.ok || res.status === 0) return
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { return } // respuesta opaca = éxito
  if (!json.ok) throw new Error(json.error ?? 'Error en el Sheet')
}

// Exporta turnos generados al Sheet (bulk_insert): reemplaza filas de esa línea+semana
export async function exportarTurnosASheet(rows) {
  const url    = (typeof localStorage !== 'undefined' ? localStorage.getItem('vip_script_url')    : null)?.trim()
  const secret = (typeof localStorage !== 'undefined' ? localStorage.getItem('vip_script_secret') : null)?.trim()
  if (!url || !secret) return
  await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, action: 'bulk_insert', rows }),
  })
}

// Sincroniza una fila individual al Sheet (action: 'update' crea si no existe)
export async function sincronizarTurnoEnSheet(url, secret, agente, fecha, campos) {
  if (!url?.trim() || !secret?.trim()) return
  await fetch(url.trim(), {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, action: 'update', agente, fecha, campos }),
  })
}

export async function aplicarCambioEnSupabase(cambio) {
  // Intercambiar TODAS las filas (turno + descanso) de cada persona en su fecha
  const [{ data: filasA }, { data: filasB }] = await Promise.all([
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_sol_fecha).ilike('agente', cambio.solicitante_nombre),
    supabase.from('vip_turnos_programados').select('id').eq('fecha', cambio.turno_rec_fecha).ilike('agente', cambio.receptor_nombre),
  ])
  if (!filasA?.length) throw new Error(`No se encontró el turno de ${cambio.solicitante_nombre} el ${cambio.turno_sol_fecha}. Verifica que el nombre coincida exactamente con el registrado en la malla.`)
  if (!filasB?.length) throw new Error(`No se encontró el turno de ${cambio.receptor_nombre} el ${cambio.turno_rec_fecha}. Verifica que el nombre coincida exactamente con el registrado en la malla.`)
  await Promise.all([
    ...filasA.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.receptor_nombre }).eq('id', r.id)),
    ...filasB.map(r => supabase.from('vip_turnos_programados').update({ agente: cambio.solicitante_nombre }).eq('id', r.id)),
  ])
}

export async function intercambiarTurnosDirecto(turno1, turno2, supervisorNombre, motivo) {
  const { error: e1 } = await supabase.from('vip_turnos_programados').update({ agente: turno2.agente }).eq('id', turno1.id)
  if (e1) throw new Error(e1.message)
  const { error: e2 } = await supabase.from('vip_turnos_programados').update({ agente: turno1.agente }).eq('id', turno2.id)
  if (e2) throw new Error(e2.message)
  await supabase.from('vip_cambios_turno').insert({
    solicitante_nombre: turno1.agente,
    receptor_nombre:    turno2.agente,
    turno_sol_fecha:    turno1.fecha,
    turno_sol_inicio:   turno1.turno_inicio,
    turno_sol_fin:      turno1.turno_fin,
    turno_rec_fecha:    turno2.fecha,
    turno_rec_inicio:   turno2.turno_inicio,
    turno_rec_fin:      turno2.turno_fin,
    motivo:             motivo || null,
    estado:             'aprobado',
    aprobado_por:       supervisorNombre,
    updated_at:         new Date().toISOString(),
  })
}

// ── Turno del analista hoy (para banner de aviso) ─────────────────────────
export async function getMiTurnoHoyLinea(nombre, linea) {
  if (!nombre) return null
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('turno_inicio, turno_fin')
    .eq('fecha', hoyISO())
    .ilike('linea_atencion', linea)
    .ilike('agente', nombre)
    .not('turno_fin', 'is', null)
    .limit(1)
    .maybeSingle()
  return data
}

// ── Redistribución manual (llama la función SQL) ───────────────────────────
export async function liberarTurnosAhora() {
  const { data, error } = await supabase.rpc('liberar_turnos_vencidos')
  if (error) throw new Error(error.message)
  return data
}

// ── Validación casos abiertos por cliente ─────────────────────────────────
export async function buscarCasosAbiertosCliente(documento, nombre) {
  const estados = ['Nuevo', 'Asignado', 'En gestión']
  const promesas = []

  if (documento?.trim() && documento.trim().length >= 5) {
    promesas.push(
      supabase.from('vip_casos')
        .select('id, numero, estado, cliente_nombre, asignado_a_nombre, created_at')
        .eq('cliente_documento', documento.trim())
        .in('estado', estados)
    )
  }
  if (nombre?.trim()) {
    promesas.push(
      supabase.from('vip_casos')
        .select('id, numero, estado, cliente_nombre, asignado_a_nombre, created_at')
        .ilike('cliente_nombre', nombre.trim())
        .in('estado', estados)
    )
  }

  if (promesas.length === 0) return []

  const results = await Promise.all(promesas)
  const todos = results.flatMap(r => r.data ?? [])
  const seen = new Set()
  return todos
    .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

export async function getUltimoUpdateCaso(casoId) {
  const { data } = await supabase
    .from('vip_hilo')
    .select('mensaje, autor_nombre, created_at')
    .eq('caso_id', casoId)
    .not('tipo', 'eq', 'sistema')
    .not('tipo', 'eq', 'asignacion')
    .not('tipo', 'eq', 'solicitud_update')
    .order('created_at', { ascending: false })
    .limit(1)
  return data?.[0] ?? null
}

export async function solicitarUpdateAnalista(casoId, solicitanteId, solicitanteNombre, solicitanteRol) {
  await addMensajeHilo(casoId, {
    autor_id: solicitanteId,
    autor_nombre: solicitanteNombre,
    autor_rol: solicitanteRol,
    mensaje: 'Se solicitó un update al analista asignado.',
    tipo: 'solicitud_update',
  })
}

// ── KPIs ───────────────────────────────────────────────────────────────────
export async function getKpisVip() {
  const hoy = hoyISO()
  const cnt = (q) => q.select('*', { count: 'exact', head: true })
  const [
    { count: total },
    { count: nuevos },
    { count: asignados },
    { count: enGestion },
    { count: resueltos },
    { count: hoyCount },
    { count: criticos },
  ] = await Promise.all([
    cnt(supabase.from('vip_casos')),
    cnt(supabase.from('vip_casos').eq('estado', 'Nuevo')),
    cnt(supabase.from('vip_casos').eq('estado', 'Asignado')),
    cnt(supabase.from('vip_casos').eq('estado', 'En gestión')),
    cnt(supabase.from('vip_casos').in('estado', ['Resuelto', 'Cerrado'])),
    cnt(supabase.from('vip_casos').gte('created_at', hoy).lte('created_at', hoy + 'T23:59:59')),
    cnt(supabase.from('vip_casos').eq('prioridad', 'Crítica').neq('estado', 'Cerrado')),
  ])
  return {
    total:     total     ?? 0,
    nuevos:    nuevos    ?? 0,
    asignados: asignados ?? 0,
    enGestion: enGestion ?? 0,
    resueltos: resueltos ?? 0,
    hoy:       hoyCount  ?? 0,
    criticos:  criticos  ?? 0,
  }
}

// ── Horas extras ───────────────────────────────────────────────────────────────
export async function reportarHorasExtra({ agente, fecha, horasExtra, comentario, aprobadoPor }) {
  const { error } = await supabase
    .from('vip_horas_extras')
    .insert({ agente, fecha, horas_extra: horasExtra, comentario: comentario || null, aprobado_por: aprobadoPor || null })
  if (error) throw new Error(error.message)
}

export async function getMisHorasExtra(agente, limit = 20) {
  const { data } = await supabase
    .from('vip_horas_extras')
    .select('*')
    .ilike('agente', agente)
    .order('fecha', { ascending: false })
    .limit(limit)
  return data ?? []
}

export async function getHorasExtraAnalista(agente, desde, hasta) {
  const { data } = await supabase
    .from('vip_horas_extras')
    .select('*')
    .ilike('agente', agente)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha')
  return data ?? []
}

export async function getTodasHorasExtra(desde, hasta) {
  const { data } = await supabase
    .from('vip_horas_extras')
    .select('*')
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha')
  return data ?? []
}

export async function actualizarTurnoProgramado(id, campos) {
  const { error } = await supabase
    .from('vip_turnos_programados')
    .update(campos)
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function crearTurnoProgramado(campos) {
  const { error } = await supabase
    .from('vip_turnos_programados')
    .insert(campos)
  if (error) throw new Error(error.message)
}

// ── WFM ────────────────────────────────────────────────────────────────────────
// Devuelve { created_at } de los últimos N días para el mapa de calor
export async function getCasosHistoricoWFM(diasAtras = 90) {
  const desde = new Date(Date.now() - diasAtras * 86400000).toISOString()
  const { data } = await supabase
    .from('vip_casos')
    .select('created_at')
    .gte('created_at', desde)
  return data ?? []
}

// Devuelve filas de la tabla wfm_interacciones (datos importados desde Metabase/CSV)
export async function getWFMInteracciones() {
  const PAGE = 1000
  let all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('wfm_interacciones')
      .select('linea,dia,hora,interacciones')
      .range(from, from + PAGE - 1)
    if (error) { console.error('[WFM] Error cargando interacciones:', error); break }
    if (!data || !data.length) break
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all.filter(r => r.interacciones > 0)
}

// Reemplaza todos los datos de una línea: borra primero, luego inserta en chunks
export async function upsertWFMInteracciones(rows) {
  if (!rows.length) return
  const linea = rows[0].linea

  const { error: delError } = await supabase
    .from('wfm_interacciones')
    .delete()
    .eq('linea', linea)
  if (delError) throw delError

  const CHUNK = 150
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('wfm_interacciones')
      .insert(rows.slice(i, i + CHUNK))
    if (error) throw error
  }
}

// Turnos de un analista en un rango de fechas (para el calendario mensual)
export async function getTurnosMesAnalista(nombre, inicio, fin) {
  const { data, error } = await supabase
    .from('vip_turnos_programados')
    .select('fecha, turno_inicio, turno_fin, linea_atencion')
    .ilike('agente', nombre)
    .gte('fecha', inicio)
    .lte('fecha', fin)
    .order('fecha')
  if (error) throw new Error(error.message)
  return data ?? []
}

// Analistas únicos con turnos recientes para una línea (últimos 28 días)
export async function getAnalistasLinea(linea) {
  const desde = new Date()
  desde.setDate(desde.getDate() - 28)
  const { data } = await supabase
    .from('vip_turnos_programados')
    .select('agente')
    .ilike('linea_atencion', linea)
    .gte('fecha', desde.toISOString().slice(0, 10))
    .not('agente', 'is', null)
  return [...new Set((data ?? []).map(r => r.agente).filter(Boolean))].sort()
}

// Guarda turnos generados automáticamente: borra los de esa semana+línea, luego inserta
export async function saveTurnosProgramadosBulk(rows, linea) {
  if (!rows.length) return 0
  const fechas = [...new Set(rows.map(r => r.fecha))]
  const { error: delErr } = await supabase
    .from('vip_turnos_programados')
    .delete()
    .in('fecha', fechas)
    .ilike('linea_atencion', linea)
  if (delErr) throw new Error(delErr.message)
  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from('vip_turnos_programados').insert(rows.slice(i, i + CHUNK))
    if (error) throw new Error(error.message)
  }
  return rows.length
}

// Devuelve la rotación completa de trasnocho para una línea:
// - analistas: lista alfabética de activos (últimos 28 días)
// - historial: ordenado por "más tiempo sin trasnocho" (nunca = primero)
// - siguiente: agente al que le toca esta semana
export async function getRotacionTrasnocho(linea) {
  const desde = new Date()
  desde.setDate(desde.getDate() - 28)
  const { data: recientes } = await supabase
    .from('vip_turnos_programados')
    .select('agente')
    .ilike('linea_atencion', linea)
    .gte('fecha', desde.toISOString().slice(0, 10))
    .not('agente', 'is', null)
  const analistas = [...new Set((recientes ?? []).map(r => r.agente).filter(Boolean))].sort()
  if (!analistas.length) return { analistas: [], historial: [], siguiente: null }

  const { data: hist } = await supabase
    .from('vip_turnos_programados')
    .select('agente, fecha')
    .ilike('linea_atencion', linea)
    .eq('turno_inicio', '22:00')
    .not('agente', 'is', null)
    .order('fecha', { ascending: false })

  const ultimaFecha = {}
  for (const r of (hist ?? [])) {
    if (!ultimaFecha[r.agente]) ultimaFecha[r.agente] = r.fecha
  }

  const historial = analistas.map(a => ({
    agente: a,
    ultimaFecha: ultimaFecha[a] || null,
  })).sort((a, b) => {
    const fa = a.ultimaFecha || '0000-00-00'
    const fb = b.ultimaFecha || '0000-00-00'
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })

  return { analistas, historial, siguiente: historial[0]?.agente || null }
}

// ── Pausas / breaks ──────────────────────────────────────────────────────────

function _hoyISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

export async function iniciarPausa(agente, tipo, duracionProg = null) {
  const { data, error } = await supabase
    .from('vip_pausas')
    .insert({ agente, tipo, duracion_prog: duracionProg })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function terminarPausa(id) {
  const { data: pausa } = await supabase
    .from('vip_pausas').select('inicio_real, duracion_prog').eq('id', id).single()
  if (!pausa) throw new Error('Pausa no encontrada')
  const durReal = Math.round((Date.now() - new Date(pausa.inicio_real).getTime()) / 60000)
  const excedido = pausa.duracion_prog != null ? durReal - pausa.duracion_prog : null
  const { error } = await supabase.from('vip_pausas').update({
    fin_real: new Date().toISOString(),
    duracion_real: durReal,
    excedido_min: excedido,
  }).eq('id', id)
  if (error) throw new Error(error.message)
  return { durReal, excedido }
}

export async function getPausaActiva(agente) {
  const { data } = await supabase
    .from('vip_pausas')
    .select('*')
    .eq('agente', agente)
    .is('fin_real', null)
    .order('inicio_real', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

export async function getPausasHoy(agente) {
  const { data } = await supabase
    .from('vip_pausas')
    .select('*')
    .eq('agente', agente)
    .eq('fecha', _hoyISO())
    .order('inicio_real')
  return data ?? []
}

export async function getPausasHoyTodos() {
  const { data } = await supabase
    .from('vip_pausas')
    .select('*')
    .eq('fecha', _hoyISO())
    .order('agente, inicio_real')
  return data ?? []
}
