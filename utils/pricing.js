// utils/pricing.js — Règles de prix de la boutique, côté serveur.
//
// ⚠️  Doit rester STRICTEMENT alignée sur front/src/utils/pricing.js.
//
// Le serveur recalcule lui-même le prix de chaque article au lieu de croire
// celui envoyé par le navigateur : un panier bogué (ou un client malin) ne
// peut plus enregistrer une commande à un autre prix que celui du catalogue,
// ni le transmettre à Ecotrack comme montant à encaisser.

/* Prix unitaire du palier atteint par la quantité. */
function getPriceForQty(qty, baseUnitPrice, sizePrice, priceTiers = []) {
  if (!priceTiers.length) return baseUnitPrice
  const sorted = [...priceTiers].sort((a, b) => a.qty - b.qty)
  let tierPrice = sizePrice
  for (const t of sorted) { if (qty >= t.qty) tierPrice = t.price }
  return tierPrice + (baseUnitPrice - sizePrice)
}

/* Prix unitaire d'un article : palier + recto-verso + couleurs du design. */
function unitPriceFor(product, size, quantity, doubleSided, numberOfColors) {
  const sizeObj   = (product?.sizes || []).find(s => String(s.size) === String(size))
  if (!sizeObj) return null
  const sizePrice = Number(sizeObj.price) || 0
  const tiers     = Array.isArray(sizeObj.priceTiers) ? sizeObj.priceTiers : []
  const qty       = Number(quantity) || 0

  const tierPrice   = getPriceForQty(qty, sizePrice, sizePrice, tiers)
  const extraDouble = (doubleSided && product.doubleSided) ? (Number(product.doubleSidedPrice) || 0) : 0
  const nbColors    = Math.max(1, Number(numberOfColors) || 1)
  const extraColors = (product.colorDesignEnabled && nbColors > 1)
    ? (nbColors - 1) * (Number(product.colorDesignPricePerColor) || 0) : 0

  return tierPrice + extraDouble + extraColors
}

module.exports = { getPriceForQty, unitPriceFor }
