const mongoose = require('mongoose')
const bcrypt   = require('bcryptjs')

// ── Rôles de la plateforme interne ───────────────────────────────────────────
// superadmin      : voit et modifie tout, crée les comptes des autres services
// chef_production : lecture seule (stock/confirmatrice/designer/production),
//                   seul à pouvoir AJOUTER du stock, gère la livraison
// confirmatrice   : confirme les commandes reçues du site
// designer        : réalise le design puis l'envoie en production
// production      : fabrique, consomme le stock, envoie à l'emballage
// emballage       : emballe la commande finie
// insolation      : reçoit les commandes validées par le designer et les
//                   marque « confirmé » une fois son travail fait
const ROLES = ['superadmin', 'chef_production', 'confirmatrice', 'designer', 'insolation', 'production', 'emballage']

const userSchema = new mongoose.Schema(
  {
    username:     { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role:         { type: String, required: true, enum: ROLES },
    fullName:     { type: String, default: '' },   // nom affiché (optionnel)
    active:       { type: Boolean, default: true },
    createdBy:    { type: String, default: '' },    // username du superadmin créateur
  },
  { timestamps: true }
)

// L'index unique sur username est déjà créé par `unique: true`

// ── Méthodes utilitaires ─────────────────────────────────────────────────────
userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 10)
}

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash)
}

// Ne jamais renvoyer le hash au client
userSchema.methods.toSafeJSON = function () {
  return {
    _id:       this._id,
    username:  this.username,
    role:      this.role,
    fullName:  this.fullName,
    active:    this.active,
    createdBy: this.createdBy,
    createdAt: this.createdAt,
  }
}

module.exports = mongoose.model('User', userSchema)
module.exports.ROLES = ROLES
