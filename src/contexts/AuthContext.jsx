import { createContext, useContext, useEffect, useState } from 'react'
import { signInWithPopup } from 'firebase/auth'
import { supabase } from '../lib/supabase'
import { auth, googleProvider } from '../lib/firebase'

const AuthContext = createContext(null)

const DOMINIO = 'somosinternet.co'
const ROLES_BYPASS = ['admin', 'kam']

function _derivarHabilidades(lineas) {
  const habs = new Set()
  for (const l of lineas) {
    if (l.includes('especializado') || l.includes('soporte tv') || l.includes('soporte_tv') || l.includes('vip')) {
      habs.add('vip')
    }
    if (l.includes('retencion') || l.includes('retención') || l.includes('retenció')) {
      habs.add('retencion')
    }
    if (l.includes('sara')) {
      habs.add('cobranzas')
    }
  }
  return Array.from(habs)
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [habilidades, setHabilidades] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else {
        setProfile(null)
        setHabilidades([])
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    setProfile(data)
    if (!data) { setLoading(false); return }

    // 1. Habilidades manuales asignadas por admin
    const { data: habsData } = await supabase
      .from('supervisor_habilidades')
      .select('habilidad')
      .eq('supervisor_id', userId)
    const habsManual = (habsData ?? []).map(h => h.habilidad)

    // 2. Habilidades automáticas derivadas de la célula (linea_atencion) en turnos
    let habsAuto = []
    if (!ROLES_BYPASS.includes(data.role)) {
      const nombreBusqueda = data.nombre_turno || data.full_name
      if (nombreBusqueda) {
        const { data: turnos } = await supabase
          .from('vip_turnos_programados')
          .select('linea_atencion')
          .ilike('agente', nombreBusqueda)
          .not('linea_atencion', 'is', null)
          .limit(100)
        if (turnos?.length) {
          const lineas = [...new Set(turnos.map(t => t.linea_atencion?.toLowerCase().trim()).filter(Boolean))]
          habsAuto = _derivarHabilidades(lineas)
        }
      }
    }

    // 3. Unión: auto (turnos) + manual (admin) — sin duplicados
    setHabilidades([...new Set([...habsAuto, ...habsManual])])
    setLoading(false)
  }

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password })
    return { data, error }
  }

  async function signInWithGoogle() {
    // 1. Firebase Google popup
    const result = await signInWithPopup(auth, googleProvider)
    const fbUser = result.user
    const email = fbUser.email?.toLowerCase()

    // 2. Validar dominio
    if (!email?.endsWith(`@${DOMINIO}`)) {
      await auth.signOut()
      throw new Error(`Solo se permiten cuentas @${DOMINIO}.`)
    }

    // 3. Verificar que el email esté en vip_empleados (ilike = case-insensitive)
    const { data: empleado } = await supabase
      .from('vip_empleados')
      .select('nombre_completo')
      .ilike('email', email)
      .maybeSingle()

    if (!empleado) {
      await auth.signOut()
      throw new Error('Tu correo no está en la lista de empleados autorizados. Contacta a tu administrador.')
    }

    // 4. Vincular con Supabase usando UID de Firebase como contraseña determinista
    const sbPassword = `GGL_${fbUser.uid}`

    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password: sbPassword })

    if (signInErr) {
      // Primera vez: crear la cuenta en Supabase
      const { data, error: signUpErr } = await supabase.auth.signUp({ email, password: sbPassword })
      if (signUpErr) {
        if (signUpErr.message?.includes('already registered')) {
          await auth.signOut()
          const err = new Error('CUENTA_CON_PASSWORD')
          err.code = 'CUENTA_CON_PASSWORD'
          err.migracionData = { email, sbPassword }
          throw err
        }
        throw new Error(signUpErr.message)
      }
      // Si Supabase requiere confirmación de email, la sesión vendrá por onAuthStateChange
      if (!data.session) {
        throw new Error('Se envió un correo de confirmación. Revísalo y vuelve a intentar.')
      }
    }
  }

  async function migrarCuentaAGoogle(email, passwordActual, sbPassword) {
    const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password: passwordActual })
    if (loginErr) throw new Error('Contraseña incorrecta.')
    const { error: updateErr } = await supabase.auth.updateUser({ password: sbPassword })
    if (updateErr) throw new Error(updateErr.message)
  }

  async function signOut() {
    await supabase.auth.signOut()
    try { await auth.signOut() } catch (_) {}
  }

  async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { error }
  }

  async function refreshProfile() {
    if (user) await fetchProfile(user.id)
  }

  const value = { user, profile, habilidades, loading, signIn, signUp, signInWithGoogle, migrarCuentaAGoogle, signOut, resetPassword, refreshProfile }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}
