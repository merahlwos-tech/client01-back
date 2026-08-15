// utils/ecotrack.js
// Logique d'envoi d'une commande à Ecotrack (compagnie de livraison).
// Extrait de orderRoutes.js pour être partagé entre l'admin e-commerce et le
// chef de production (plateforme interne). Comportement identique à l'original.

const ECOTRACK_BASE  = process.env.ECOTRACK_BASE_URL  || 'https://ecotrack.dz'
const ECOTRACK_TOKEN = process.env.ECOTRACK_API_TOKEN || ''

const ecoHeaders = () => ({
  'Content-Type': 'application/json',
  ...(ECOTRACK_TOKEN ? { Authorization: `Bearer ${ECOTRACK_TOKEN}` } : {}),
})

// Envoie la commande à Ecotrack et renseigne order.ecotrackTracking / ecotrackSentAt.
// NB : ne fait PAS order.save() — l'appelant sauvegarde.
async function sendToEcotrack(order) {
  if (order.ecotrackTracking) return { alreadySent: true, tracking: order.ecotrackTracking }

  const { customerInfo, total, items } = order
  const wilayaCode = customerInfo.wilayaCode

  if (!wilayaCode) {
    console.warn(`[ECOTRACK] Order ${order._id}: wilayaCode manquant, envoi ignoré`)
    return { error: 'wilayaCode manquant' }
  }

  const produitLabel = items.map(i => `${i.name} x${i.quantity}`).join(', ').slice(0, 255)

  const params = new URLSearchParams({
    reference:   order._id.toString().slice(-8).toUpperCase(),
    nom_client:  `${customerInfo.firstName} ${customerInfo.lastName}`,
    telephone:   customerInfo.phone.replace(/\s/g, ''),
    adresse:     customerInfo.commune,
    commune:     customerInfo.commune,
    code_wilaya: String(wilayaCode),
    montant:     String(total),
    type:        '1',
    stop_desk:   customerInfo.deliveryMethod === 'Stop Desk' ? '1' : '0',
    produit:     produitLabel,
  })

  const resp = await fetch(`${ECOTRACK_BASE}/api/v1/create/order?${params.toString()}`, {
    method: 'POST',
    headers: ecoHeaders(),
  })
  const data = await resp.json()

  if (!data.success) {
    console.error('[ECOTRACK] Erreur envoi commande:', data)
    return { error: data.message || 'Erreur Ecotrack', details: data.errors }
  }

  order.ecotrackTracking = data.tracking
  order.ecotrackSentAt   = new Date()
  return { tracking: data.tracking }
}

module.exports = { sendToEcotrack, ecoHeaders, ECOTRACK_BASE, ECOTRACK_TOKEN }
