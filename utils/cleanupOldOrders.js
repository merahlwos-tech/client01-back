// utils/cleanupOldOrders.js
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  SUPPRESSION DÉFINITIVE DE COMMANDES
//
// Deux durées de conservation :
//   • commande ANNULÉE   → supprimée 30 jours après son annulation
//   • toute autre        → supprimée 90 jours (3 mois) après sa création
//
// Les logos clients et fichiers de design associés sont effacés de Cloudinary
// en même temps. L'opération est IRRÉVERSIBLE : il n'y a pas de corbeille.
//
// 👉 Pour désactiver complètement la purge : ORDER_RETENTION_DAYS=0 dans
//    l'environnement (variable Render).
// ─────────────────────────────────────────────────────────────────────────────

const Order      = require('../models/Order')
const cloudinary = require('../config/cloudinary')

// Trois mois pour les commandes menées à leur terme
const RETENTION_DAYS = process.env.ORDER_RETENTION_DAYS !== undefined
  ? Number(process.env.ORDER_RETENTION_DAYS)
  : 90

// Un mois pour les commandes annulées
const CANCELLED_RETENTION_DAYS = process.env.CANCELLED_RETENTION_DAYS !== undefined
  ? Number(process.env.CANCELLED_RETENTION_DAYS)
  : 30

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

function extractCloudinaryPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i)
    return match ? match[1] : null
  } catch { return null }
}

/* Supprime les commandes correspondant au filtre, et avec elles les fichiers
   Cloudinary qu'elles référencent. Le nettoyage des fichiers est « best
   effort » : un échec Cloudinary ne doit pas empêcher la suppression. */
async function deleteOrdersWhere(filter) {
  const doomed = await Order.find(filter)
    .select('_id customerInfo.logoUrls pipeline.design.files')
    .lean()
  if (doomed.length === 0) return { deleted: 0, files: 0 }

  const urls = doomed.flatMap(o => [
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

  const result = await Order.deleteMany({ _id: { $in: doomed.map(o => o._id) } })
  return { deleted: result.deletedCount, files: urls.length }
}

// Suppression manuelle depuis un panel (sélection de commandes)
async function deleteOrdersByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0, files: 0 }
  return deleteOrdersWhere({ _id: { $in: ids } })
}

async function cleanupOldOrders() {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return { skipped: true }

  /* Commandes annulées : le point de départ est la date d'annulation. Les
     annulations antérieures à ce champ retombent sur la date de création. */
  const cancelled = CANCELLED_RETENTION_DAYS > 0
    ? await deleteOrdersWhere({
        'pipeline.stage': 'annulee',
        $or: [
          { 'pipeline.cancelledAt': { $ne: null, $lt: daysAgo(CANCELLED_RETENTION_DAYS) } },
          { 'pipeline.cancelledAt': null, createdAt: { $lt: daysAgo(CANCELLED_RETENTION_DAYS) } },
        ],
      })
    : { deleted: 0, files: 0 }

  // Toutes les autres, sur leur date de création
  const old = await deleteOrdersWhere({ createdAt: { $lt: daysAgo(RETENTION_DAYS) } })

  const total = cancelled.deleted + old.deleted
  if (total > 0) {
    console.log(`🗑️  [PURGE] ${cancelled.deleted} annulée(s) de plus de ${CANCELLED_RETENTION_DAYS} j`
      + ` + ${old.deleted} de plus de ${RETENTION_DAYS} j`
      + ` — ${cancelled.files + old.files} fichier(s) associé(s)`)
  }
  return { deleted: total, cancelled: cancelled.deleted, old: old.deleted }
}

// Lance la purge au démarrage puis toutes les 6 heures
function scheduleCleanup() {
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
    console.log('ℹ️  [PURGE] désactivée (ORDER_RETENTION_DAYS=0)')
    return
  }
  console.log(`🗑️  [PURGE] active — annulées après ${CANCELLED_RETENTION_DAYS} j,`
    + ` les autres après ${RETENTION_DAYS} j`)

  const run = () => cleanupOldOrders().catch(err => console.error('[PURGE] erreur:', err.message))

  setTimeout(run, 60 * 1000)                    // 1 min après le démarrage
  setInterval(run, 6 * 60 * 60 * 1000)          // puis toutes les 6 h
}

module.exports = {
  cleanupOldOrders, scheduleCleanup, deleteOrdersByIds,
  RETENTION_DAYS, CANCELLED_RETENTION_DAYS,
}
