// utils/orderStatus.js — Règles de statut d'une commande, PARTAGÉES.
//
// Le panneau /admin e-commerce et l'atelier modifient tous deux le statut
// d'une commande. Chacun avait sa propre copie de la logique, et elles ont
// divergé : changer un statut depuis /admin laissait l'atelier dans l'état
// d'avant (étape inchangée, pas de compte à rebours, annulation sans date).
// Une seule implémentation ici, appelée par les deux.

const Order = require('../models/Order')

// Statut public ⇄ étape du circuit de l'atelier
const STATUS_TO_STAGE = {
  'en attente': 'confirmation',
  'confirmé':   'design',      // confirmé → part chez le designer
  'annulé':     'annulee',
}
const VALID_STATUSES = Object.keys(STATUS_TO_STAGE)

// Ordre du circuit, pour savoir ce qu'une étape « après » a pu poser
const CIRCUIT = ['confirmation', 'design', 'production', 'emballage', 'livraison', 'termine']

// Démarre (ou redémarre) le compte à rebours de l'atelier
function startCountdown(order) {
  const now = new Date()
  order.pipeline.confirmedAt = now
  order.pipeline.deadlineAt  = new Date(now.getTime() + Order.DEADLINE_DAYS * 24 * 60 * 60 * 1000)
}

/* Ramener une commande à `stage` doit défaire ce que les étapes suivantes
   avaient posé. Sinon elle reste « fabriquée » ou « envoyée » alors qu'on la
   renvoie en arrière, et disparaît des listes fondées sur ces dates — un état
   qu'aucun écran ne sait plus rattraper. Sans effet quand on avance. */
function resetAfterStage(order, stage) {
  const cible = CIRCUIT.indexOf(stage)
  if (cible === -1) return
  const p = order.pipeline

  if (cible <= CIRCUIT.indexOf('livraison'))  p.deliveredAt = null
  if (cible <= CIRCUIT.indexOf('emballage'))  p.packagedAt  = null
  if (cible <= CIRCUIT.indexOf('production')) p.producedAt  = null
  if (cible <= CIRCUIT.indexOf('design')) {
    p.sentToProductionAt = null
    p.productionDate     = ''
    p.productionDay      = null
    p.insolation = { status: 'en_attente', by: '', at: null, note: '' }
  }
  if (cible === CIRCUIT.indexOf('confirmation')) {
    p.designValidated   = false
    p.designValidatedAt = null
  }
}

/* Applique un statut public et tout ce qui en découle dans l'atelier.
   `actor` = { username, role } de celui qui agit. N'enregistre pas : à
   l'appelant de faire order.save() et de tracer l'historique. */
function applyStatus(order, status, actor = {}) {
  const wasConfirmed = order.status === 'confirmé'
  const nextStage    = STATUS_TO_STAGE[status]

  order.status = status
  // Une annulation fige la commande là où elle en était : on garde la trace
  if (nextStage !== 'annulee') resetAfterStage(order, nextStage)
  order.pipeline.stage = nextStage

  // La commande est tranchée : elle quitte l'onglet « Commandes »
  order.pipeline.statusSetAt = new Date()
  order.pipeline.statusSetBy = actor.username || ''

  // Passage en « confirmé » → démarre le compte à rebours de 6 jours
  if (status === 'confirmé') {
    order.pipeline.confirmedBy = actor.username || ''
    if (!wasConfirmed) startCountdown(order)
  }

  /* L'annulation lance le compte à rebours de purge (30 jours). Un retour
     en arrière l'efface : la commande n'est plus condamnée. */
  if (status === 'annulé') {
    if (!order.pipeline.cancelledAt) {
      order.pipeline.cancelledAt   = new Date()
      order.pipeline.cancelledBy   = actor.username || ''
      order.pipeline.cancelledRole = actor.role || ''
    }
  } else {
    order.pipeline.cancelledAt   = null
    order.pipeline.cancelledBy   = ''
    order.pipeline.cancelledRole = ''
  }

  return nextStage
}

module.exports = {
  STATUS_TO_STAGE, VALID_STATUSES, CIRCUIT,
  startCountdown, resetAfterStage, applyStatus,
}
