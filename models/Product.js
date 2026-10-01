const mongoose = require('mongoose')

// Palier de prix dégressif : à partir de `qty` unités, l'unité coûte `price`
const priceTierSchema = new mongoose.Schema({
  qty:   { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
}, { _id: false })

const sizeSchema = new mongoose.Schema({
  size:  { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  /* Les paliers existaient en base mais pas dans le schéma : Mongoose les
     supprimait à chaque enregistrement d'un produit depuis /admin, et les
     prix dégressifs disparaissaient sans prévenir. */
  priceTiers: { type: [priceTierSchema], default: [] },
})

const productSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ['Board', 'Bags', 'Autocollants', 'Paper'],
    },
    position: { type: Number, default: 9999 },   // ordre dans la catégorie (plus petit = premier)
    sizes:  { type: [sizeSchema], default: [] },
    images: { type: [String],    default: [] },

    colors:                 { type: [String], default: [] },
    colorDesignEnabled:     { type: Boolean, default: false },   // option "couleurs dans le design" activée
    colorDesignPricePerColor: { type: Number, default: 0 },      // prix DA par couleur ajoutée
    colorDesignMaxColors:   { type: Number, default: null },      // limite max (optionnel)
    doubleSided:            { type: Boolean, default: false },
    doubleSidedPrice: { type: Number,   default: 0, min: 0 },
    tags:             { type: [String], default: [] },
  },
  { timestamps: true }
)

// ── Index ──────────────────────────────────────────────────────────────────
// Accélère les requêtes GET /products?category=X (très fréquentes)
productSchema.index({ category: 1, position: 1 })
productSchema.index({ category: 1, createdAt: -1 })
// Accélère la recherche par nom dans l'admin
productSchema.index({ name: 'text' })

module.exports = mongoose.model('Product', productSchema)
