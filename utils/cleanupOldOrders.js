// utils/cleanupOldOrders.js
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  SUPPRESSION DÉFINITIVE DE COMMANDES
//
// Toute commande dont la date de création dépasse ORDER_RETENTION_DAYS (90 par
// défaut, soit trois mois) est supprimée, ainsi que les logos clients associés
// sur Cloudinary (images et PDF).
// L'opération est IRRÉVERSIBLE : il n'y a pas de corbeille.
//
// 👉 Pour ne purger QUE les commandes terminées ou annulées (et donc conserver
//    celles encore en cours), passer ONLY_FINISHED à true ci-dessous.
//
// 👉 Pour désactiver complètement la purge : ORDER_RETENTION_DAYS=0 dans
//    l'environnement (variable Render).
// ─────────────────────────────────────────────────────────────────────────────

const Order      = require('../models/Order')
const cloudinary = require('../config/cloudinary')

// Trois mois
const RETENTION_DAYS = process.env.ORDER_RETENTION_DAYS !== undefined
  ? Number(process.env.ORDER_RETENTION_DAYS)
  : 90

// Passer à true pour épargner les commandes encore en cours de traitement
const ONLY_FINISHED = false

function extractCloudinaryPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i)
    return match ? match[1] : null
  } catch { return null }
}

async function cleanupOldOrders() {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return { skipped: true }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const filter = { createdAt: { $lt: cutoff } }
  if (ONLY_FINISHED) {
    filter['pipeline.stage'] = { $in: ['termine', 'annulee'] }
  }

  // On récupère d'abord les commandes pour nettoyer leurs fichiers
  const old = await Order.find(filter)
    .select('_id customerInfo.logoUrls pipeline.design.files')
    .lean()
  if (old.length === 0) return { deleted: 0 }

  // Logos clients + fichiers de design hérités (best effort : un échec ne bloque pas)
  const urls = old.flatMap(o => [
    ...(o.customerInfo?.logoUrls || []),
    ...(o.pipeline?.design?.files || []),
  ])
  await Promise.all(urls.map(url => {
    const publicId = extractCloudinaryPublicId(url)
    if (!publicId) return Promise.resolve()
    const resourceType = url.includes('/raw/') ? 'raw' : 'image'
    return cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
      .catch(err => console.error('[PURGE] Cloudinary:', publicId, err.message))
  }))

  const result = await Order.deleteMany({ _id: { $in: old.map(o => o._id) } })
  console.log(`🗑️  [PURGE] ${result.deletedCount} commande(s) de plus de ${RETENTION_DAYS} jours supprimée(s), ${urls.length} fichier(s) associé(s)`)
  return { deleted: result.deletedCount, files: urls.length }
}

// Lance la purge au démarrage puis toutes les 6 heures
function scheduleCleanup() {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
    console.log('ℹ️  [PURGE] désactivée (ORDER_RETENTION_DAYS=0)')
    return
  }
  console.log(`🗑️  [PURGE] active — commandes supprimées après ${RETENTION_DAYS} jours`)

  const run = () => cleanupOldOrders().catch(err => console.error('[PURGE] erreur:', err.message))

  setTimeout(run, 60 * 1000)                    // 1 min après le démarrage
  setInterval(run, 6 * 60 * 60 * 1000)          // puis toutes les 6 h
}

module.exports = { cleanupOldOrders, scheduleCleanup, RETENTION_DAYS }
