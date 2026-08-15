// scripts/seedStaff.js
// Crée (ou réinitialise) les comptes de service de l'atelier.
//
//   node scripts/seedStaff.js
//
// Idempotent : relancer le script remet simplement le mot de passe à jour
// sans créer de doublon. Les comptes existants gardent leur rôle.
//
// ⚠️  Mots de passe de test volontairement simples — à changer avant
//     l'ouverture réelle de l'atelier (panel « Comptes » du superadmin).

require('dotenv').config()
const mongoose = require('mongoose')
const User     = require('../models/User')

const PASSWORD = process.env.SEED_PASSWORD || 'admin'

// identifiant = nom du service (les identifiants doivent être uniques)
const ACCOUNTS = [
  { username: 'superadmin',    role: 'superadmin',      fullName: 'Super Admin' },
  { username: 'chef',          role: 'chef_production', fullName: 'Chef de production' },
  { username: 'confirmatrice', role: 'confirmatrice',   fullName: 'Confirmatrice' },
  { username: 'designer',      role: 'designer',        fullName: 'Designer' },
  { username: 'production',    role: 'production',      fullName: 'Production' },
  { username: 'emballage',     role: 'emballage',       fullName: 'Emballage' },
]

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI manquant dans l\'environnement.')
    process.exit(1)
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  console.log('✅ MongoDB connecté\n')

  for (const acc of ACCOUNTS) {
    let user = await User.findOne({ username: acc.username })

    if (user) {
      await user.setPassword(PASSWORD)
      user.active = true
      await user.save()
      console.log(`↻  ${acc.username.padEnd(14)} (${acc.role}) — mot de passe réinitialisé`)
    } else {
      user = new User({
        username:  acc.username,
        role:      acc.role,
        fullName:  acc.fullName,
        createdBy: 'seed-script',
      })
      await user.setPassword(PASSWORD)
      await user.save()
      console.log(`✚  ${acc.username.padEnd(14)} (${acc.role}) — compte créé`)
    }
  }

  console.log(`\n🔑 Mot de passe pour tous les comptes : « ${PASSWORD} »`)
  console.log('   Pensez à le changer depuis le panel « Comptes ».\n')

  await mongoose.disconnect()
  process.exit(0)
}

main().catch(err => {
  console.error('❌ Erreur :', err.message)
  process.exit(1)
})
