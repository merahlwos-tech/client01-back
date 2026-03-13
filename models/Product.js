const mongoose = require('mongoose')

const sizeSchema = new mongoose.Schema({
  size:  { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
})

const productSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ['Board', 'Bags', 'Autocollants', 'Paper'],
    },
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
productSchema.index({ category: 1, createdAt: -1 })
// Accélère la recherche par nom dans l'admin
productSchema.index({ name: 'text' })

module.exports = mongoose.model('Product', productSchema)