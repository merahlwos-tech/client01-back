// utils/migrations.js
// Petites mises à niveau de données, exécutées au démarrage.
// Chacune doit être idempotente : relancée, elle ne fait rien de plus.

const Order = require('../models/Order')
const { normalizePhone } = require('./phone')

/* `pipeline.statusSetAt` distingue les commandes déjà traitées par la
   confirmatrice. Il n'existait pas auparavant : les commandes dont le statut
   n'est plus « en attente » ont donc bien été décidées, on les marque comme
   telles pour qu'elles ne réapparaissent pas dans l'onglet « Commandes ». */
async function backfillStatusSetAt() {
  // Le pipeline d'agrégation permet de reprendre `updatedAt` comme date de
  // décision. Mongoose 9 exige `updatePipeline: true` pour l'accepter.
  const res = await Order.updateMany(
    { 'pipeline.statusSetAt': null, status: { $ne: 'en attente' } },
    [{ $set: { 'pipeline.statusSetAt': '$updatedAt', 'pipeline.statusSetBy': 'historique' } }],
    { updatePipeline: true }
  )
  if (res.modifiedCount > 0) {
    console.log(`🔧 [MIGRATION] ${res.modifiedCount} commande(s) marquée(s) comme déjà traitées`)
  }
  return res.modifiedCount
}

/* Tous les numéros au même format (0XXXXXXXXX). Les commandes enregistrées
   avant cette règle gardaient les espaces, points ou indicatif saisis.
   On écrit directement dans la collection : ni validation ni `updatedAt`,
   seul le numéro change. */
async function normalizeStoredPhones() {
  const orders = await Order.find({}, { 'customerInfo.phone': 1, 'customerInfo.extraPhones': 1 }).lean()
  const ops = []
  for (const o of orders) {
    const ci = o.customerInfo || {}
    const phone = normalizePhone(ci.phone)
    const seen  = new Set([phone])
    const extra = []
    for (const p of (ci.extraPhones || [])) {
      const v = normalizePhone(p)
      if (v && !seen.has(v)) { seen.add(v); extra.push(v) }
    }
    const set = {}
    if (phone && phone !== ci.phone) set['customerInfo.phone'] = phone
    if (JSON.stringify(extra) !== JSON.stringify(ci.extraPhones || [])) set['customerInfo.extraPhones'] = extra
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: set } } })
  }
  if (ops.length > 0) {
    await Order.collection.bulkWrite(ops)
    console.log(`🔧 [MIGRATION] ${ops.length} numéro(s) de téléphone mis au format`)
  }
  return ops.length
}

async function runMigrations() {
  try {
    await backfillStatusSetAt()
    await normalizeStoredPhones()
  } catch (err) {
    console.error('[MIGRATION] erreur:', err.message)
  }
}

module.exports = { runMigrations, backfillStatusSetAt, normalizeStoredPhones }
