const BOT_TOKEN          = import.meta.env.VITE_SLACK_BOT_TOKEN
const WEBHOOK_SUPERVISORES = import.meta.env.VITE_SLACK_WEBHOOK_SUPERVISORES

async function dm(slackUserId, texto) {
  if (!BOT_TOKEN || !slackUserId) return
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: slackUserId, text: texto }),
  }).catch(() => {})
}

async function supervisores(texto) {
  if (!WEBHOOK_SUPERVISORES) return
  await fetch(WEBHOOK_SUPERVISORES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  }).catch(() => {})
}

export async function notificarCasoCreado(caso, slackIdAnalista) {
  const prioridad = caso.prioridad === 'Crítica' ? '🔴 Crítica' : '🟡 Alta'
  const base = `*${caso.numero}* — ${caso.cliente_nombre}\n>${caso.tipo_problema} | ${prioridad}`
  if (slackIdAnalista) {
    await dm(slackIdAnalista,
      `📋 *Nuevo caso asignado a ti*\n${base}\nAbre el CRM para gestionar: crm-somosinternet.vercel.app/vip`
    )
  }
  await supervisores(
    `✅ *Caso asignado* a *${caso.asignado_a_nombre ?? 'Sin asignar'}*\n${base}`
  )
}
