import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getTurnosSemana, getWFMInteracciones, upsertWFMInteracciones, getAnalistasLinea, saveTurnosProgramadosBulk, getRotacionTrasnocho, exportarTurnosASheet } from '../lib/vip'
import { ChevronLeft, ChevronRight, Users, TrendingUp, AlertTriangle, Settings2, Upload, X, CheckCircle, CalendarPlus, Moon } from 'lucide-react'

// ── Helpers de fecha ──────────────────────────────────────────────────────────
function getLunes(offset = 0) {
  const hoy = new Date()
  const dow = hoy.getDay() || 7
  const lunes = new Date(hoy)
  lunes.setDate(hoy.getDate() - (dow - 1) + offset * 7)
  lunes.setHours(0, 0, 0, 0)
  return lunes
}

function toISO(d) {
  return d.toISOString().slice(0, 10)
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function parseHDec(s) {
  if (!s) return null
  const [h, m] = String(s).split(':').map(Number)
  return h + (m || 0) / 60
}

function labelSemana(lunes) {
  const dom = addDays(lunes, 6)
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  const dL = lunes.getDate(), mL = meses[lunes.getMonth()]
  const dD = dom.getDate(), mD = meses[dom.getMonth()]
  const y = dom.getFullYear()
  if (lunes.getMonth() === dom.getMonth()) return `${dL}–${dD} ${mL} ${y}`
  return `${dL} ${mL} – ${dD} ${mD} ${y}`
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = []
  let current = '', inQuotes = false
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = '' }
    else { current += char }
  }
  result.push(current.trim())
  return result
}

function parseWFMCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const header = parseCSVLine(lines[0])
  const days = header.slice(1).map(d => parseInt(d, 10)).filter(d => !isNaN(d))
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i])
    if (!cols.length) continue
    const hora = parseInt(cols[0], 10)
    if (isNaN(hora) || hora < 0 || hora > 23) continue
    for (let j = 0; j < days.length; j++) {
      const dia = days[j]
      if (!dia || dia < 1 || dia > 31) continue
      const raw = (cols[j + 1] || '0').replace(/,/g, '')
      const val = parseFloat(raw)
      const intVal = Math.round(val)
      if (!isNaN(val) && val > 0) rows.push({ dia, hora, interacciones: Math.max(1, intVal) })
    }
  }
  return rows
}

// ── Cobertura: { `${fecha}_${hora}`: count } ─────────────────────────────────
function calcCobertura(turnos, lineaFiltro) {
  const mapa = {}
  for (const t of turnos) {
    if (!t.turno_inicio || !t.turno_fin || !t.fecha) continue
    if (lineaFiltro && t.linea_atencion?.toLowerCase() !== lineaFiltro.toLowerCase()) continue

    let sH = parseHDec(t.turno_inicio)
    let eH = parseHDec(t.turno_fin)
    if (sH === null || eH === null) continue
    if (eH <= sH) eH += 24

    const bkS = parseHDec(t.break_inicio), bkE = parseHDec(t.break_fin)
    const lcS = parseHDec(t.lunch_inicio), lcE = parseHDec(t.lunch_fin)

    for (let h = Math.ceil(sH); h < eH; h++) {
      const hNorm = h % 24
      if (hNorm < 6 || hNorm > 23) continue
      if (bkS !== null && bkE !== null && h >= bkS && h + 1 <= bkE) continue
      if (lcS !== null && lcE !== null && h >= lcS && h + 1 <= lcE) continue
      const key = `${t.fecha}_${hNorm}`
      mapa[key] = (mapa[key] || 0) + 1
    }
  }
  return mapa
}

// ── Demanda desde wfm_interacciones ──────────────────────────────────────────
// Mapea día del mes → día de semana usando el calendario del mes de la semana seleccionada
function calcDemandaFromWFM(wfmData, linea, lunes) {
  const year = lunes.getFullYear()
  const month = lunes.getMonth() + 1

  const filtered = linea
    ? wfmData.filter(r => r.linea.toLowerCase().trim() === linea.toLowerCase().trim())
    : wfmData

  const lookup = new Map()
  for (const r of filtered) {
    const key = `${r.dia}_${r.hora}`
    lookup.set(key, (lookup.get(key) || 0) + r.interacciones)
  }

  const byDowHour = {}
  const dowCount = {}
  for (let dow = 0; dow < 7; dow++) {
    byDowHour[dow] = {}
    dowCount[dow] = 0
    for (let h = 0; h <= 23; h++) byDowHour[dow][h] = 0
  }

  const daysInMonth = new Date(year, month, 0).getDate()
  for (let dia = 1; dia <= daysInMonth; dia++) {
    const dow = new Date(year, month - 1, dia).getDay()
    dowCount[dow]++
    for (let h = 0; h <= 23; h++) {
      byDowHour[dow][h] += lookup.get(`${dia}_${h}`) || 0
    }
  }

  for (let dow = 0; dow < 7; dow++) {
    if (dowCount[dow] > 0) {
      for (let h = 0; h <= 23; h++) {
        byDowHour[dow][h] = Math.round((byDowHour[dow][h] / dowCount[dow]) * 10) / 10
      }
    }
  }

  return { byDowHour, weekCount: 1 }
}

// ── Brecha ────────────────────────────────────────────────────────────────────
function calcGapRows(lunes, cobertura, heatmap, objetivo) {
  const { byDowHour, weekCount } = heatmap
  const rows = []
  const DOW_MAP = [1, 2, 3, 4, 5, 6, 0]
  const DIA_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
  for (let d = 0; d < 7; d++) {
    const fecha = toISO(addDays(lunes, d))
    const dow = DOW_MAP[d]
    for (let h = 6; h <= 23; h++) {
      const interacciones = (byDowHour[dow]?.[h] || 0) / weekCount
      const recomendado = Math.max(1, Math.ceil(interacciones / objetivo))
      const programado = cobertura[`${fecha}_${h}`] || 0
      const brecha = programado - recomendado
      if (brecha !== 0) {
        rows.push({ dia: DIA_LABELS[d], fecha, hora: h, programado, demanda: Math.round(interacciones * 10) / 10, recomendado, brecha })
      }
    }
  }
  return rows
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
function calcKPIs(lunes, cobertura) {
  let totalHoras = 0, maxAgentes = 0, peakHora = null
  for (let d = 0; d < 7; d++) {
    const fecha = toISO(addDays(lunes, d))
    for (let h = 6; h <= 23; h++) {
      const cnt = cobertura[`${fecha}_${h}`] || 0
      totalHoras += cnt
      if (cnt > maxAgentes) { maxAgentes = cnt; peakHora = h }
    }
  }
  const avgAgentes = Math.round((totalHoras / (7 * 18)) * 10) / 10
  return { totalHoras, avgAgentes, peakHora, maxAgentes }
}

// ── Auto-scheduler helpers ────────────────────────────────────────────────────
function findBestShifts(required) {
  const scores = []
  for (let startH = 5; startH <= 14; startH++) {
    let score = 0
    for (let d = 0; d < 7; d++) {
      for (let hi = 0; hi < 18; hi++) {
        const h = hi + 6
        if (h >= startH && h < startH + 8) score += required[d][hi]
      }
    }
    scores.push({ startH, endH: startH + 8, score })
  }
  scores.sort((a, b) => b.score - a.score)
  const selected = []
  for (const s of scores) {
    if (selected.length >= 2) break
    if (!selected.some(sel => Math.abs(sel.startH - s.startH) < 4)) selected.push(s)
  }
  selected.sort((a, b) => a.startH - b.startH)
  return selected.map(s => ({
    inicio: `${String(s.startH).padStart(2, '0')}:00`,
    fin:    `${String(s.endH).padStart(2, '0')}:00`,
    label:  `${String(s.startH).padStart(2, '0')}-${String(s.endH).padStart(2, '0')}`,
    startH: s.startH, endH: s.endH,
  }))
}

function genSchedule(analistas, heatmap, objetivo, lunes, options = {}) {
  const { forzarTrasnocho = false } = options
  const DOW_MAP    = [1, 2, 3, 4, 5, 6, 0]
  const DIA_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
  const n = analistas.length
  if (!n) return null

  const startOfYear = new Date(lunes.getFullYear(), 0, 1)
  const weekOfYear  = Math.floor((lunes - startOfYear) / (7 * 86400000))

  // Separar analista de trasnocho — usa índice del historial real, fallback a weekOfYear % n
  const TRASNOCHO = { inicio: '22:00', fin: '06:00', label: '22-06', startH: 22, endH: 30 }
  const trasnochIdx = options.trasnochIdx !== undefined ? options.trasnochIdx : (weekOfYear % n)
  const analistaTrasnocho = (forzarTrasnocho && n > 1) ? analistas[trasnochIdx] : null
  const analistasReg = analistaTrasnocho ? analistas.filter((_, i) => i !== trasnochIdx) : analistas
  const nReg = analistasReg.length

  const required = Array.from({ length: 7 }, (_, d) => {
    const dow = DOW_MAP[d]
    return Array.from({ length: 18 }, (_, hi) => {
      const h = hi + 6
      const demand = (heatmap.byDowHour[dow]?.[h] || 0) / heatmap.weekCount
      return demand > 0 ? Math.max(1, Math.ceil(demand / objetivo)) : 0
    })
  })

  // Con trasnocho activo: 7 franjas fijas de 8h para cobertura 24/7 (los analistas rotan una franja/semana)
  // Sin trasnocho: franjas basadas en demanda
  const SHIFTS_ESPECIALIZADO = [
    { inicio: '02:00', fin: '10:00', label: '02-10', startH: 2,  endH: 10 },
    { inicio: '06:00', fin: '14:00', label: '06-14', startH: 6,  endH: 14 },
    { inicio: '07:00', fin: '15:00', label: '07-15', startH: 7,  endH: 15 },
    { inicio: '09:00', fin: '17:00', label: '09-17', startH: 9,  endH: 17 },
    { inicio: '11:00', fin: '19:00', label: '11-19', startH: 11, endH: 19 },
    { inicio: '12:00', fin: '20:00', label: '12-20', startH: 12, endH: 20 },
    { inicio: '14:00', fin: '22:00', label: '14-22', startH: 14, endH: 22 },
  ]
  const shifts = forzarTrasnocho ? SHIFTS_ESPECIALIZADO : findBestShifts(required)
  if (!shifts.length) return null

  const assignments = analistasReg.map((analista, idx) => {
    const shiftIdx = (weekOfYear + idx) % shifts.length  // rota 1 franja por semana
    const shift    = shifts[shiftIdx]
    const offStart = (Math.round(idx * 7 / nReg) + weekOfYear) % 7
    const offDays  = new Set([offStart])

    const turnos = []
    for (let d = 0; d < 7; d++) {
      if (offDays.has(d)) continue
      if (!required[d].some(r => r > 0)) continue
      turnos.push({
        agente:       analista,
        fecha:        toISO(addDays(lunes, d)),
        dia_semana:   DIA_LABELS[d],
        turno_inicio: shift.inicio,
        turno_fin:    shift.fin,
        break_inicio: null, break_fin: null,
        lunch_inicio: null, lunch_fin: null,
      })
    }
    return { analista, shift, offDays, turnos }
  })

  // Analista de trasnocho: descansa SIEMPRE el viernes (para iniciar el sábado en la noche)
  if (analistaTrasnocho) {
    const VIERNES = 4  // Lun=0 … Vie=4 … Dom=6
    const offDays = new Set([VIERNES])
    const turnos = []
    for (let d = 0; d < 7; d++) {
      if (offDays.has(d)) continue
      turnos.push({
        agente:       analistaTrasnocho,
        fecha:        toISO(addDays(lunes, d)),
        dia_semana:   DIA_LABELS[d],
        turno_inicio: TRASNOCHO.inicio,
        turno_fin:    TRASNOCHO.fin,
        break_inicio: null, break_fin: null,
        lunch_inicio: null, lunch_fin: null,
      })
    }
    assignments.push({ analista: analistaTrasnocho, shift: TRASNOCHO, offDays, turnos })
  }

  const coverage = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 18 }, (_, hi) => {
      const h = hi + 6
      return assignments.reduce((sum, a) => {
        if (a.offDays.has(d) || !required[d].some(r => r > 0)) return sum
        return (h >= a.shift.startH && h < a.shift.endH) ? sum + 1 : sum
      }, 0)
    })
  )

  return { assignments, shifts, required, coverage }
}

// ── BarChart ──────────────────────────────────────────────────────────────────
function BarChart({ data, recomendado }) {
  const max = Math.max(...data.map(d => d.count), recomendado, 1)
  const HORAS = Array.from({ length: 18 }, (_, i) => i + 6)

  return (
    <div className="flex gap-2 items-stretch">
      {/* Eje Y */}
      <div className="flex gap-0.5 items-stretch pb-5 shrink-0">
        <div className="flex items-center justify-center" style={{ width: '14px' }}>
          <span
            className="text-[8px] text-gray-400 font-medium tracking-widest select-none"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            Agentes
          </span>
        </div>
        <div className="flex flex-col justify-between items-end" style={{ width: '16px' }}>
          <span className="text-[8px] text-gray-300 leading-none">{max}</span>
          <span className="text-[8px] text-gray-300 leading-none">{Math.round(max / 2)}</span>
          <span className="text-[8px] text-gray-300 leading-none">0</span>
        </div>
      </div>
      {/* Área principal */}
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <div className="relative h-32">
          {/* Línea de recomendado */}
          <div
            className="absolute inset-x-0 border-t-2 border-dashed border-indigo-400 opacity-70 pointer-events-none z-10"
            style={{ bottom: `${(recomendado / max) * 100}%` }}
            title={`Recomendado: ${recomendado} ag.`}
          />
          {/* Líneas de guía horizontales */}
          <div className="absolute inset-x-0 border-t border-gray-100" style={{ bottom: '50%' }} />
          <div className="absolute inset-x-0 border-t border-gray-100" style={{ bottom: '0%' }} />
          {/* Barras */}
          <div className="flex items-end gap-px h-full">
            {HORAS.map(h => {
              const cnt = data.find(d => d.hora === h)?.count || 0
              const pct = cnt / max
              const barH = Math.max(pct * 100, cnt > 0 ? 4 : 0)
              const ratio = recomendado > 0 ? cnt / recomendado : 1
              const color = ratio >= 1 ? 'bg-green-500' : ratio >= 0.5 ? 'bg-amber-400' : 'bg-red-500'
              return (
                <div
                  key={h}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                  title={`${h}:00 — ${cnt} agente${cnt !== 1 ? 's' : ''}`}
                >
                  <div
                    className={`w-full rounded-t transition-all relative ${color}`}
                    style={{ height: `${barH}%` }}
                  >
                    {cnt > 0 && barH >= 22 && (
                      <span className="absolute inset-x-0 top-0.5 text-center text-[8px] text-white/90 leading-none font-medium">
                        {cnt}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {/* Eje X: horas */}
        <div className="flex gap-px">
          {HORAS.map(h => (
            <div key={h} className="flex-1 text-center text-[9px] text-gray-400 leading-none">{h}</div>
          ))}
        </div>
        {/* Etiqueta eje X */}
        <div className="text-right text-[8px] text-gray-300 font-medium tracking-wide mt-0.5">
          Hora del día →
        </div>
      </div>
    </div>
  )
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
function Heatmap({ byDowHour, weekCount }) {
  const HORAS = Array.from({ length: 18 }, (_, i) => i + 6)
  const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
  const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]

  const maxVal = Math.max(
    ...DOW_ORDER.flatMap(dow => HORAS.map(h => (byDowHour[dow]?.[h] || 0) / weekCount)),
    1
  )

  function intensityClass(val) {
    const r = val / maxVal
    if (r === 0) return 'bg-gray-100 text-gray-300'
    if (r < 0.2) return 'bg-indigo-100 text-indigo-400'
    if (r < 0.4) return 'bg-indigo-200 text-indigo-600'
    if (r < 0.6) return 'bg-indigo-300 text-indigo-700'
    if (r < 0.8) return 'bg-indigo-400 text-white'
    return 'bg-indigo-600 text-white'
  }

  return (
    <div className="overflow-x-auto">
      {/* min-w garantiza que flex-1 del header tenga suficiente espacio para alinearse con el grid */}
      <div style={{ minWidth: '640px' }}>
      <div className="flex ml-10 mb-0.5">
        {HORAS.map(h => (
          <div key={h} className="flex-1 text-center text-[9px] text-gray-400 font-medium">{h}</div>
        ))}
      </div>
      {DOW_ORDER.map(dow => (
        <div key={dow} className="flex items-center mb-0.5">
          <div className="w-10 text-[10px] text-gray-500 font-medium text-right shrink-0 pr-1">{DIAS[dow]}</div>
          <div className="flex-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(18, 1fr)', gap: '1px' }}>
            {HORAS.map(h => {
              const rawVal = (byDowHour[dow]?.[h] || 0) / weekCount
              const displayVal = Math.round(rawVal * 10) / 10
              return (
                <div
                  key={h}
                  className={`rounded text-[9px] text-center py-1 leading-none font-medium overflow-hidden transition-colors ${intensityClass(rawVal)}`}
                  title={`${DIAS[dow]} ${h}:00 — ${displayVal} int/sem`}
                >
                  {displayVal > 0 ? (displayVal >= 10 ? Math.round(displayVal) : displayVal) : ''}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      </div>{/* fin min-width */}
    </div>
  )
}

// ── ImportModal ───────────────────────────────────────────────────────────────
function ImportModal({ lineas, onClose, onImportado }) {
  const [linea, setLinea] = useState(lineas[0] || '')
  const [lineaCustom, setLineaCustom] = useState('')
  const [rawRows, setRawRows] = useState([])
  const [parsed, setParsed] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ok, setOk] = useState(false)
  const [err, setErr] = useState(null)

  const lineaEfectiva = linea === '__custom' ? lineaCustom.trim() : linea

  function handleFile(e) {
    const f = e.target.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const rows = parseWFMCsv(evt.target.result)
        if (!rows.length) throw new Error('No se encontraron datos en el CSV. Verifica que el archivo sea el correcto (Hora × Día del mes).')
        const horas = [...new Set(rows.map(r => r.hora))].sort((a, b) => a - b)
        const dias = [...new Set(rows.map(r => r.dia))].sort((a, b) => a - b)
        setRawRows(rows)
        setParsed({ count: rows.length, horas, diasCount: dias.length })
        setErr(null)
      } catch (e2) {
        setErr('Error al leer el CSV: ' + e2.message)
        setRawRows([])
        setParsed(null)
      }
    }
    reader.readAsText(f, 'UTF-8')
  }

  async function handleImport() {
    if (!rawRows.length || !lineaEfectiva) return
    setLoading(true)
    setErr(null)
    try {
      const toUpload = rawRows.map(r => ({
        linea: lineaEfectiva,
        dia: r.dia,
        hora: r.hora,
        interacciones: r.interacciones,
      }))
      await upsertWFMInteracciones(toUpload)
      setOk(true)
      setTimeout(() => { onImportado(); onClose() }, 1200)
    } catch (e2) {
      setErr(e2.message)
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900">Importar CSV de demanda</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-700">Línea de atención</label>
          <select
            value={linea}
            onChange={e => setLinea(e.target.value)}
            className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">— Selecciona —</option>
            {lineas.map(l => <option key={l} value={l}>{l}</option>)}
            <option value="__custom">Otra línea…</option>
          </select>
          {linea === '__custom' && (
            <input
              type="text"
              placeholder="Nombre exacto de la línea"
              value={lineaCustom}
              onChange={e => setLineaCustom(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-700">Archivo CSV (Metabase · Mapa Calor Mes)</label>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFile}
            className="block w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
          />
          <p className="text-[10px] text-gray-400">Formato: Hora×Día como exporta Metabase (filas=horas, columnas=días 01–31)</p>
        </div>

        {parsed && !err && (
          <div className="bg-indigo-50 rounded-lg px-3 py-2.5 text-xs text-indigo-700 space-y-1">
            <p><strong>{parsed.count}</strong> registros leídos — {parsed.diasCount} días, {parsed.horas.length} horas con datos</p>
            <p className="text-indigo-500">Horas detectadas: {parsed.horas.join(', ')}</p>
          </div>
        )}
        {err && (
          <div className="bg-red-50 rounded-lg px-3 py-2.5 text-xs text-red-700">{err}</div>
        )}
        {ok && (
          <div className="bg-green-50 rounded-lg px-3 py-2.5 text-xs text-green-700 flex items-center gap-2">
            <CheckCircle className="w-3.5 h-3.5 shrink-0" /> Datos importados correctamente
          </div>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onClose}
            className="text-xs px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleImport}
            disabled={!parsed || !lineaEfectiva || loading || ok}
            className="text-xs px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" />
            {loading ? 'Importando…' : 'Importar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const DIA_PILLS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const PILL_TO_DOW = [1, 2, 3, 4, 5, 6, 0]

export default function VipWFM() {
  const { profile } = useAuth()
  const role = profile?.role ?? ''

  const [offset, setOffset] = useState(0)
  const [lineaFiltro, setLineaFiltro] = useState('')
  const [turnos, setTurnos] = useState([])
  const [wfmData, setWfmData] = useState([])
  const [loading, setLoading] = useState(true)
  const [objetivo, setObjetivo] = useState(4)
  const [showConfig, setShowConfig] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)

  const todayPillIdx = (() => {
    const dow = new Date().getDay()
    const idx = PILL_TO_DOW.indexOf(dow)
    return idx >= 0 ? idx : 0
  })()
  const [diaIdx, setDiaIdx] = useState(todayPillIdx)

  const lunes = useMemo(() => getLunes(offset), [offset])
  const inicio = useMemo(() => toISO(lunes), [lunes])
  const fin = useMemo(() => toISO(addDays(lunes, 6)), [lunes])

  async function cargarWFM() {
    const data = await getWFMInteracciones()
    setWfmData(data)
  }

  useEffect(() => {
    let cancelled = false
    async function cargar() {
      setLoading(true)
      const [t, w] = await Promise.all([
        getTurnosSemana(inicio, fin),
        getWFMInteracciones(),
      ])
      if (!cancelled) {
        setTurnos(t)
        setWfmData(w)
        setLoading(false)
      }
    }
    cargar()
    return () => { cancelled = true }
  }, [inicio, fin])

  // Líneas disponibles: unión de turnos + wfm (para que aparezcan aunque no haya turnos esta semana)
  const lineas = useMemo(
    () => [...new Set([
      ...turnos.map(t => t.linea_atencion).filter(Boolean),
      ...wfmData.map(w => w.linea).filter(Boolean),
    ])].sort(),
    [turnos, wfmData]
  )

  const cobertura = useMemo(() => calcCobertura(turnos, lineaFiltro), [turnos, lineaFiltro])
  const heatmap   = useMemo(() => calcDemandaFromWFM(wfmData, lineaFiltro, lunes), [wfmData, lineaFiltro, lunes])
  const kpis      = useMemo(() => calcKPIs(lunes, cobertura), [lunes, cobertura])
  const gapRows   = useMemo(() => calcGapRows(lunes, cobertura, heatmap, objetivo), [lunes, cobertura, heatmap, objetivo])

  const barData = useMemo(() => {
    const fecha = toISO(addDays(lunes, diaIdx))
    return Array.from({ length: 18 }, (_, i) => {
      const h = i + 6
      return { hora: h, count: cobertura[`${fecha}_${h}`] || 0 }
    })
  }, [lunes, diaIdx, cobertura])

  const recomendadoDia = useMemo(() => {
    const dow = PILL_TO_DOW[diaIdx]
    const vals = Array.from({ length: 18 }, (_, i) => {
      const h = i + 6
      const avg = (heatmap.byDowHour[dow]?.[h] || 0) / heatmap.weekCount
      return Math.max(1, Math.ceil(avg / objetivo))
    })
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) || 1
  }, [diaIdx, heatmap, objetivo])

  const mesLabel = useMemo(
    () => MESES[lunes.getMonth()] + ' ' + lunes.getFullYear(),
    [lunes]
  )

  const hasWFMData = useMemo(() => {
    if (!lineaFiltro) return wfmData.length > 0
    return wfmData.some(r => r.linea.toLowerCase() === lineaFiltro.toLowerCase())
  }, [wfmData, lineaFiltro])

  if (!['admin', 'supervisor'].includes(role)) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        No tienes permisos para ver esta página.
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">

      {/* ── Encabezado ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">WFM — Workforce Management</h1>
          <p className="text-xs text-gray-500 mt-0.5">Cobertura, demanda histórica y brechas por línea</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lineas.length > 0 && (
            <select
              value={lineaFiltro}
              onChange={e => setLineaFiltro(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Todas las líneas</option>
              {lineas.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors font-medium"
          >
            <Upload className="w-3.5 h-3.5" />
            Importar CSV
          </button>
          <button
            onClick={() => setShowScheduler(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-green-200 text-green-700 bg-green-50 hover:bg-green-100 transition-colors font-medium"
          >
            <CalendarPlus className="w-3.5 h-3.5" />
            Generar turnos
          </button>
          <button
            onClick={() => setShowConfig(v => !v)}
            className={`p-1.5 rounded-lg border transition-colors ${showConfig ? 'bg-indigo-50 border-indigo-300 text-indigo-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
            title="Configurar objetivo"
          >
            <Settings2 className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-2 py-1">
            <button onClick={() => setOffset(o => o - 1)} className="p-0.5 hover:bg-gray-100 rounded transition-colors">
              <ChevronLeft className="w-4 h-4 text-gray-600" />
            </button>
            <span className="text-xs font-medium text-gray-700 min-w-[130px] text-center">{labelSemana(lunes)}</span>
            <button onClick={() => setOffset(o => o + 1)} className="p-0.5 hover:bg-gray-100 rounded transition-colors">
              <ChevronRight className="w-4 h-4 text-gray-600" />
            </button>
          </div>
        </div>
      </div>

      {/* Config */}
      {showConfig && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center gap-4 flex-wrap">
          <Settings2 className="w-4 h-4 text-indigo-500 shrink-0" />
          <label className="text-xs text-indigo-800 font-medium">Interacciones por agente/hora (objetivo):</label>
          <input
            type="number" min={1} max={20} value={objetivo}
            onChange={e => setObjetivo(Math.max(1, Number(e.target.value)))}
            className="w-16 text-xs border border-indigo-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <span className="text-xs text-indigo-500">Usado para calcular agentes recomendados</span>
        </div>
      )}

      {/* Sin datos de demanda */}
      {!loading && !hasWFMData && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-amber-800">Sin datos de demanda histórica{lineaFiltro ? ` para "${lineaFiltro}"` : ''}</p>
            <p className="text-xs text-amber-600 mt-0.5">
              Haz clic en <strong>Importar CSV</strong> y sube el archivo de Metabase para esta línea.
            </p>
          </div>
        </div>
      )}

      {/* ── KPIs ── */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse h-20" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiPill icon={<Users className="w-4 h-4 text-indigo-500" />} label="Horas-agente semana" value={kpis.totalHoras} bg="bg-indigo-50" />
          <KpiPill icon={<TrendingUp className="w-4 h-4 text-green-500" />} label="Agentes promedio/hora" value={kpis.avgAgentes} bg="bg-green-50" />
          <KpiPill
            icon={<TrendingUp className="w-4 h-4 text-amber-500" />}
            label="Hora pico"
            value={kpis.peakHora !== null ? `${kpis.peakHora}:00 (${kpis.maxAgentes} ag.)` : '—'}
            bg="bg-amber-50"
          />
          <KpiPill
            icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
            label="Mayor brecha"
            value={gapRows.length > 0
              ? (() => {
                  const worst = gapRows.reduce((a, b) => Math.abs(b.brecha) > Math.abs(a.brecha) ? b : a)
                  return `${worst.dia} ${worst.hora}:00 (${worst.brecha > 0 ? '+' : ''}${worst.brecha})`
                })()
              : 'Sin brechas'}
            bg="bg-red-50"
          />
        </div>
      )}

      {/* ── Cobertura ── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Cobertura de agentes</h2>
            <p className="text-xs text-gray-400 mt-0.5">Agentes en turno por hora — {lineaFiltro || 'todas las líneas'}</p>
          </div>
          <div className="flex gap-1 flex-wrap">
            {DIA_PILLS.map((label, i) => (
              <button
                key={i}
                onClick={() => setDiaIdx(i)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${diaIdx === i ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="h-36 animate-pulse bg-gray-50 rounded-lg" />
        ) : (
          <>
            <BarChart data={barData} recomendado={recomendadoDia} />
            <div className="flex gap-4 mt-3 flex-wrap">
              <LegendItem color="bg-green-500" label={`≥ recomendado (${recomendadoDia} ag.)`} />
              <LegendItem color="bg-amber-400" label="50–99%" />
              <LegendItem color="bg-red-500" label="< 50%" />
              <span className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="inline-block w-6 border-t-2 border-dashed border-indigo-400" />
                Recomendado
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Heatmap ── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-gray-800">Demanda histórica — interacciones/hora</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {hasWFMData
              ? `Promedio de interacciones por hora · ${mesLabel} · ${lineaFiltro || 'todas las líneas'}`
              : 'Sin datos — importa un CSV de Metabase'}
          </p>
          {hasWFMData && (
            <p className="text-[10px] text-gray-300 mt-0.5">
              Filas = días de la semana · Columnas = hora del día · Número en celda = promedio de interacciones
            </p>
          )}
        </div>
        {loading ? (
          <div className="h-48 animate-pulse bg-gray-50 rounded-lg" />
        ) : (
          <Heatmap byDowHour={heatmap.byDowHour} weekCount={heatmap.weekCount} />
        )}
      </div>

      {/* ── Gap analysis ── */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-gray-800">Análisis de brechas</h2>
          <p className="text-xs text-gray-400 mt-0.5">Diferencia entre cobertura programada y demanda histórica</p>
        </div>
        {loading ? (
          <div className="h-32 animate-pulse bg-gray-50 rounded-lg" />
        ) : gapRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400 gap-2">
            <AlertTriangle className="w-7 h-7 opacity-30" />
            <p className="text-sm">{hasWFMData ? 'Sin brechas esta semana' : 'Importa datos de demanda para ver brechas'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-2 pr-3 font-medium">Día</th>
                  <th className="pb-2 pr-3 font-medium">Hora</th>
                  <th className="pb-2 pr-3 font-medium text-right">Prog.</th>
                  <th className="pb-2 pr-3 font-medium text-right">Demanda hist.</th>
                  <th className="pb-2 pr-3 font-medium text-right">Recom.</th>
                  <th className="pb-2 font-medium text-right">Brecha</th>
                </tr>
              </thead>
              <tbody>
                {gapRows.map((row, i) => (
                  <tr key={i} className={`border-b border-gray-50 ${row.programado < row.recomendado ? 'bg-red-50 text-red-700' : 'text-gray-700'}`}>
                    <td className="py-1.5 pr-3">{row.dia}</td>
                    <td className="py-1.5 pr-3">{row.hora}:00</td>
                    <td className="py-1.5 pr-3 text-right font-medium">{row.programado}</td>
                    <td className="py-1.5 pr-3 text-right">{row.demanda}</td>
                    <td className="py-1.5 pr-3 text-right">{row.recomendado}</td>
                    <td className={`py-1.5 text-right font-semibold ${row.brecha > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {row.brecha > 0 ? `+${row.brecha}` : row.brecha}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showImport && (
        <ImportModal
          lineas={lineas}
          onClose={() => setShowImport(false)}
          onImportado={cargarWFM}
        />
      )}

      {showScheduler && (
        <AutoSchedulerModal
          lineas={lineas.length > 0 ? lineas : wfmData.map(w => w.linea).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).sort()}
          wfmData={wfmData}
          objetivo={objetivo}
          lunes={lunes}
          onClose={() => setShowScheduler(false)}
          onSaved={async () => {
            const t = await getTurnosSemana(inicio, fin)
            setTurnos(t)
          }}
        />
      )}
    </div>
  )
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function KpiPill({ icon, label, value, bg }) {
  return (
    <div className={`${bg} rounded-xl p-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">{label}</span>
      </div>
      <span className="text-lg font-bold text-gray-800 leading-tight">{value ?? '—'}</span>
    </div>
  )
}

function LegendItem({ color, label }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-500">
      <span className={`inline-block w-3 h-3 rounded-sm ${color}`} />
      {label}
    </span>
  )
}

// ── AutoSchedulerModal ────────────────────────────────────────────────────────
function AutoSchedulerModal({ lineas, wfmData, objetivo, lunes, onClose, onSaved }) {
  const [lineaGen, setLineaGen] = useState(
    lineas.find(l => l.toUpperCase().includes('ESPECIALIZADO')) || lineas[0] || ''
  )
  const [analistas, setAnalistas] = useState([])
  const [activos, setActivos] = useState(new Set())
  const [loadingAna, setLoadingAna] = useState(false)
  const [schedule, setSchedule] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [forzarTrasnocho, setForzarTrasnocho] = useState(false)
  const [rotacion, setRotacion] = useState({ analistas: [], historial: [], siguiente: null })

  useEffect(() => {
    setForzarTrasnocho(lineaGen.toUpperCase().includes('ESPECIALIZADO'))
  }, [lineaGen])

  useEffect(() => {
    if (!lineaGen) return
    setLoadingAna(true)
    setSchedule(null)
    setRotacion({ analistas: [], historial: [], siguiente: null })
    getRotacionTrasnocho(lineaGen).then(rot => {
      setAnalistas(rot.analistas)
      setActivos(new Set(rot.analistas))
      setRotacion(rot)
      setLoadingAna(false)
    })
  }, [lineaGen])

  const heatmap = useMemo(
    () => calcDemandaFromWFM(wfmData, lineaGen, lunes),
    [wfmData, lineaGen, lunes]
  )

  const hasWFM = wfmData.some(r => r.linea.toLowerCase() === lineaGen.toLowerCase())

  function handleGenerar() {
    const lista = analistas.filter(a => activos.has(a))
    if (!lista.length) return setErr('Selecciona al menos un analista')
    if (forzarTrasnocho && lista.length < 2) return setErr('Se necesitan al menos 2 analistas para incluir un turno trasnocho')
    let trasnochIdx = undefined
    if (forzarTrasnocho) {
      const activosEnRotacion = rotacion.historial.filter(h => activos.has(h.agente))
      const siguiente = activosEnRotacion[0]?.agente || null
      const idx = siguiente ? lista.findIndex(a => a.toLowerCase() === siguiente.toLowerCase()) : 0
      trasnochIdx = idx === -1 ? 0 : idx
    }
    const result = genSchedule(lista, heatmap, objetivo, lunes, { forzarTrasnocho, trasnochIdx })
    if (!result) return setErr('No hay suficientes datos de demanda para generar turnos')
    setErr(null)
    setSchedule(result)
  }

  async function handleGuardar() {
    if (!schedule) return
    setSaving(true); setErr(null)
    try {
      const rows = schedule.assignments.flatMap(a =>
        a.turnos.map(t => ({ ...t, linea_atencion: lineaGen }))
      )
      await saveTurnosProgramadosBulk(rows, lineaGen)
      exportarTurnosASheet(rows).catch(() => {}) // respaldo en Sheet, fire-and-forget
      onSaved()
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto p-6 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <CalendarPlus className="w-4 h-4 text-green-600" />
              Generador de turnos automático
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">{labelSemana(lunes)}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!schedule ? (
          <>
            {/* Line selector */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Línea de atención</label>
              <select
                value={lineaGen}
                onChange={e => { setLineaGen(e.target.value); setErr(null) }}
                className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-400"
              >
                {lineas.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>

            {/* No WFM data */}
            {!hasWFM && lineaGen && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Sin datos de demanda para <strong>{lineaGen}</strong>. Importa el CSV primero.
              </div>
            )}

            {/* Analyst list */}
            {loadingAna ? (
              <div className="h-24 animate-pulse bg-gray-50 rounded-lg" />
            ) : analistas.length > 0 ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-700">
                    Analistas ({activos.size} de {analistas.length} seleccionados)
                  </label>
                  <button
                    onClick={() => setActivos(activos.size === analistas.length ? new Set() : new Set(analistas))}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    {activos.size === analistas.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                  </button>
                </div>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-44 overflow-y-auto">
                  {analistas.map(a => (
                    <label key={a} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activos.has(a)}
                        onChange={() => {
                          const s = new Set(activos)
                          s.has(a) ? s.delete(a) : s.add(a)
                          setActivos(s)
                        }}
                        className="rounded text-indigo-600 w-3.5 h-3.5"
                      />
                      <span className="text-xs text-gray-700">{a}</span>
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-gray-400">Analistas con turnos en los últimos 28 días para esta línea.</p>
              </div>
            ) : null}

            {/* Opción trasnocho */}
            {analistas.length > 0 && (
              <label className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 select-none">
                <input
                  type="checkbox"
                  checked={forzarTrasnocho}
                  onChange={e => setForzarTrasnocho(e.target.checked)}
                  className="rounded text-indigo-600 w-3.5 h-3.5"
                />
                <div>
                  <p className="text-xs font-medium text-gray-700">Incluir turno trasnocho (22:00 – 06:00)</p>
                  <p className="text-[10px] text-gray-400">El último analista de la lista rotará en turno nocturno toda la semana</p>
                </div>
              </label>
            )}

            {forzarTrasnocho && analistas.length > 0 && (() => {
              const activosEnRotacion = rotacion.historial.filter(h => activos.has(h.agente))
              const siguienteAgente = activosEnRotacion[0]?.agente || null
              return (
                <div className="bg-indigo-50 rounded-lg px-3 py-2.5 space-y-2">
                  <p className="text-xs font-medium text-indigo-700 flex items-center gap-1.5">
                    <Moon className="w-3 h-3" /> Rotación de trasnocho
                  </p>
                  <div className="bg-white rounded-lg divide-y divide-gray-100 overflow-hidden">
                    {rotacion.historial.map(r => {
                      const activo = activos.has(r.agente)
                      const esSiguiente = r.agente === siguienteAgente
                      return (
                        <div key={r.agente} className={`flex items-center justify-between px-2.5 py-1.5 text-[11px] ${esSiguiente ? 'bg-indigo-100 font-semibold text-indigo-800' : activo ? 'text-gray-600' : 'text-gray-300'}`}>
                          <span className="flex items-center gap-1.5">
                            {esSiguiente ? <Moon className="w-2.5 h-2.5 text-indigo-500" /> : <span className="w-2.5 inline-block" />}
                            {r.agente}
                            {!activo && <span className="text-[10px] font-normal">(excluido)</span>}
                          </span>
                          <span className={`text-[10px] ${esSiguiente ? 'text-indigo-500' : 'text-gray-400'}`}>
                            {r.ultimaFecha ?? 'Nunca'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {!siguienteAgente && <p className="text-[10px] text-indigo-400">Selecciona analistas para ver la rotación</p>}
                </div>
              )
            })()}

            {lineaGen && !loadingAna && analistas.length === 0 ? (
              <div className="bg-gray-50 rounded-lg px-3 py-5 text-xs text-gray-500 text-center">
                No se encontraron analistas con turnos recientes para <strong>{lineaGen}</strong>.
                <br /><span className="text-gray-400">Programa turnos manualmente primero o impórtalos desde la hoja.</span>
              </div>
            ) : null}
          </>
        ) : (
          <SchedulePreview schedule={schedule} />
        )}

        {err && <div className="bg-red-50 rounded-lg px-3 py-2 text-xs text-red-700">{err}</div>}

        {/* Actions */}
        <div className="flex items-center justify-between pt-1 gap-2">
          <div>
            {schedule && (
              <button onClick={() => setSchedule(null)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                ← Ajustar
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
            {!schedule ? (
              <button
                onClick={handleGenerar}
                disabled={!hasWFM || !activos.size || loadingAna}
                className="text-xs px-4 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <CalendarPlus className="w-3.5 h-3.5" />
                Generar
              </button>
            ) : (
              <button
                onClick={handleGuardar}
                disabled={saving}
                className="text-xs px-4 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-40 flex items-center gap-1.5"
              >
                <CheckCircle className="w-3.5 h-3.5" />
                {saving ? 'Guardando…' : 'Guardar turnos'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SchedulePreview({ schedule }) {
  const DIA_LABELS  = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
  const SHIFT_COLORS = ['bg-blue-50 text-blue-700', 'bg-violet-50 text-violet-700']
  const { assignments, shifts, required, coverage } = schedule

  const dayStats = Array.from({ length: 7 }, (_, d) => ({
    maxReq:  Math.max(...required[d]),
    peakCov: Math.max(...coverage[d]),
  }))

  return (
    <div className="space-y-3">
      {/* Shift legend */}
      <div className="flex gap-2 flex-wrap items-center">
        {shifts.map((s, i) => (
          <span key={i} className={`text-xs px-2 py-0.5 rounded-full font-medium ${SHIFT_COLORS[i]}`}>
            T{i + 1}: {s.label}h
          </span>
        ))}
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">D = descanso</span>
        <span className="text-xs text-gray-400 ml-auto">
          {assignments.length} analistas · {assignments.reduce((s, a) => s + a.turnos.length, 0)} turnos generados
        </span>
      </div>

      {/* Assignment table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs border-collapse min-w-[480px]">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left py-1.5 px-2 text-gray-500 font-medium border border-gray-100 min-w-[110px]">Analista</th>
              {DIA_LABELS.map((d, i) => (
                <th key={i} className="py-1.5 px-1 text-gray-500 font-medium border border-gray-100 text-center min-w-[56px]">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assignments.map((a, i) => {
              const sIdx = shifts.findIndex(s => s.label === a.shift.label)
              const colors = SHIFT_COLORS[sIdx] || SHIFT_COLORS[0]
              return (
                <tr key={a.analista} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                  <td className="py-1.5 px-2 font-medium text-gray-700 border border-gray-100 max-w-[140px] truncate" title={a.analista}>
                    {a.analista}
                  </td>
                  {Array.from({ length: 7 }, (_, d) => {
                    const isOff    = a.offDays.has(d)
                    const noDemand = !required[d].some(r => r > 0)
                    return (
                      <td key={d} className={`py-1.5 px-1 text-center border border-gray-100 font-medium text-[10px] ${isOff ? 'text-gray-300' : noDemand ? 'text-gray-200' : colors}`}>
                        {noDemand ? '—' : isOff ? 'D' : a.shift.label}
                      </td>
                    )
                  })}
                </tr>
              )
            })}

            {/* Coverage summary row */}
            <tr className="border-t-2 border-gray-300 bg-gray-50">
              <td className="py-1.5 px-2 text-xs font-semibold text-gray-600 border border-gray-200">Cobertura pico</td>
              {dayStats.map((s, d) => {
                if (s.maxReq === 0) return (
                  <td key={d} className="py-1.5 px-1 text-center border border-gray-200 text-gray-300 text-[10px]">—</td>
                )
                const ratio = s.peakCov / s.maxReq
                const cls = ratio >= 1 ? 'text-green-700 bg-green-50' : ratio >= 0.5 ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50'
                return (
                  <td key={d} className="py-1.5 px-1 text-center border border-gray-200">
                    <span className={`inline-block text-[10px] font-bold px-1 py-0.5 rounded ${cls}`}>
                      {s.peakCov}/{s.maxReq}
                    </span>
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-400">
        Cobertura: agentes programados vs. necesarios en hora pico. Verde ≥ 100% · amarillo 50–99% · rojo &lt; 50%.
        Los turnos se pueden ajustar individualmente desde <em>Mis Turnos</em> después de guardar.
      </p>
    </div>
  )
}
