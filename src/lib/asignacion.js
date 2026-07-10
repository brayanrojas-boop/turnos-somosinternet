import { supabase } from './supabase'

// ── Franjas por línea ─────────────────────────────────────────────────────────
export async function getFranjas(linea) {
  const { data, error } = await supabase
    .from('vip_franjas')
    .select('*')
    .eq('linea_atencion', linea)
    .eq('activo', true)
    .order('turno_inicio')
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function saveFranja(franja) {
  const payload = {
    linea_atencion: franja.linea_atencion,
    turno_inicio: franja.turno_inicio,
    turno_fin: franja.turno_fin,
    agentes_requeridos: franja.agentes_requeridos ?? 1,
    activo: true,
  }
  if (franja.id) {
    const { error } = await supabase.from('vip_franjas').update(payload).eq('id', franja.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from('vip_franjas').insert(payload)
    if (error) throw new Error(error.message)
  }
}

export async function deleteFranja(id) {
  const { error } = await supabase.from('vip_franjas').update({ activo: false }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Novedades ─────────────────────────────────────────────────────────────────
export async function getNovedades({ fechaDesde, fechaHasta, linea }) {
  let q = supabase
    .from('vip_novedades')
    .select('*')
    .lte('fecha_inicio', fechaHasta)
    .gte('fecha_fin', fechaDesde)
    .order('fecha_inicio')
  if (linea) q = q.eq('linea_atencion', linea)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function saveNovedad(nov) {
  const payload = {
    agente: nov.agente,
    linea_atencion: nov.linea_atencion || null,
    fecha_inicio: nov.fecha_inicio,
    fecha_fin: nov.fecha_fin,
    tipo: nov.tipo,
    observacion: nov.observacion || null,
    creado_por: nov.creado_por || null,
  }
  if (nov.id) {
    const { error } = await supabase.from('vip_novedades').update(payload).eq('id', nov.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from('vip_novedades').insert(payload)
    if (error) throw new Error(error.message)
  }
}

export async function deleteNovedad(id) {
  const { error } = await supabase.from('vip_novedades').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Agentes por línea (roster) ────────────────────────────────────────────────
export async function getAgentesLinea(linea) {
  const { data, error } = await supabase
    .from('vip_turnos_programados')
    .select('agente')
    .eq('linea_atencion', linea)
    .not('agente', 'is', null)
  if (error) throw new Error(error.message)
  const seen = new Set()
  return (data ?? [])
    .map(r => r.agente)
    .filter(a => seen.has(a) ? false : seen.add(a))
    .sort()
}

// ── Turnos programados de la semana ───────────────────────────────────────────
export async function getTurnosSemanaAsignacion(linea, fechaInicio, fechaFin) {
  const { data, error } = await supabase
    .from('vip_turnos_programados')
    .select('id, agente, fecha, turno_inicio, turno_fin, novedad, linea_atencion')
    .eq('linea_atencion', linea)
    .gte('fecha', fechaInicio)
    .lte('fecha', fechaFin)
    .order('fecha')
    .order('turno_inicio')
  if (error) throw new Error(error.message)
  return data ?? []
}

// ── Asignar / desasignar ──────────────────────────────────────────────────────
export async function asignarAFranja({ agente, linea, fecha, turno_inicio, turno_fin }) {
  const { data: existing } = await supabase
    .from('vip_turnos_programados')
    .select('id')
    .eq('agente', agente)
    .eq('linea_atencion', linea)
    .eq('fecha', fecha)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('vip_turnos_programados')
      .update({ turno_inicio, turno_fin })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase
      .from('vip_turnos_programados')
      .insert({ agente, linea_atencion: linea, fecha, turno_inicio, turno_fin })
    if (error) throw new Error(error.message)
  }
}

export async function desasignarDeFranja(id) {
  const { error } = await supabase
    .from('vip_turnos_programados')
    .update({ turno_inicio: null, turno_fin: null })
    .eq('id', id)
  if (error) throw new Error(error.message)
}
