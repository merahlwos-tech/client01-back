// routes/userRoutes.js — Gestion des comptes staff (superadmin uniquement)
const express = require('express')
const router  = express.Router()
const User    = require('../models/User')
const { ROLES } = require('../models/User')
const { authenticateUser, authorize } = require('../middleware/auth')

// Toutes les routes de ce fichier exigent un superadmin (ou le compte .env legacy).
router.use(authenticateUser, authorize('superadmin'))

// GET /api/users — liste des comptes
router.get('/', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 })
    res.json(users.map(u => u.toSafeJSON()))
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// GET /api/users/roles — liste des rôles disponibles (pour le formulaire)
router.get('/roles', (req, res) => res.json(ROLES))

// POST /api/users — créer un compte { username, password, role, fullName }
router.post('/', async (req, res) => {
  try {
    const { username, password, role, fullName } = req.body

    if (!username || !password || !role) {
      return res.status(400).json({ message: 'username, password et role sont requis' })
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ message: 'Rôle invalide' })
    }
    if (String(password).length < 4) {
      return res.status(400).json({ message: 'Mot de passe trop court (min 4 caractères)' })
    }

    const uname = String(username).toLowerCase().trim()
    const exists = await User.findOne({ username: uname })
    if (exists) return res.status(409).json({ message: 'Ce nom d\'utilisateur existe déjà' })

    const user = new User({
      username:  uname,
      role,
      fullName:  fullName || '',
      createdBy: req.user?.username || '',
    })
    await user.setPassword(password)
    await user.save()

    res.status(201).json(user.toSafeJSON())
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// PATCH /api/users/:id — modifier { role, fullName, active, password }
router.patch('/:id', async (req, res) => {
  try {
    const { role, fullName, active, password } = req.body
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'Compte introuvable' })

    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ message: 'Rôle invalide' })
      user.role = role
    }
    if (fullName !== undefined) user.fullName = fullName
    if (active  !== undefined) {
      // Empêcher un superadmin de se désactiver lui-même
      if (String(user._id) === String(req.user?.userId) && active === false) {
        return res.status(400).json({ message: 'Vous ne pouvez pas désactiver votre propre compte' })
      }
      user.active = active
    }
    if (password) {
      if (String(password).length < 4) {
        return res.status(400).json({ message: 'Mot de passe trop court (min 4 caractères)' })
      }
      await user.setPassword(password)
    }

    await user.save()
    res.json(user.toSafeJSON())
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

// DELETE /api/users/:id — supprimer un compte
router.delete('/:id', async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user?.userId)) {
      return res.status(400).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' })
    }
    const user = await User.findByIdAndDelete(req.params.id)
    if (!user) return res.status(404).json({ message: 'Compte introuvable' })
    res.json({ message: 'Compte supprimé' })
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message })
  }
})

module.exports = router
