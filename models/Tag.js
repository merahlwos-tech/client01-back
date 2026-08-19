const mongoose = require('mongoose')

// Portée d'un tag : chaque service gère ses propres étiquettes
const TAG_SCOPES = ['confirmatrice', 'designer']

// Étiquettes créées librement par la confirmatrice ou le designer.
// (Distinctes de l'urgence et de « réponses lentes », qui sont figées.)
const tagSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true, trim: true, maxlength: 30 },
    color:     { type: String, default: '#7c3aed' },   // couleur d'affichage
    scope:     { type: String, enum: TAG_SCOPES, required: true },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
)

// Un même nom ne peut pas exister deux fois dans un même service
tagSchema.index({ scope: 1, name: 1 }, { unique: true })

module.exports = mongoose.model('Tag', tagSchema)
module.exports.TAG_SCOPES = TAG_SCOPES
