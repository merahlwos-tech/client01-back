const express  = require('express')
const router   = express.Router()
const Settings = require('../models/Settings')

/* ─────────────────────────────────────────────────────────────
   GET /api/settings/hidden-categories  — route PUBLIQUE
   Retourne la liste des catégories cachées sans authentification
   (utilisé par le frontend pour masquer les cartes / liens nav)
   ─────────────────────────────────────────────────────────── */
router.get('/hidden-categories', async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'hiddenCategories' }).lean()
    res.json(setting?.value || [])
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router

/* ─────────────────────────────────────────────────────────────
   PHOTOS DE COUVERTURE DES CATÉGORIES
   ─────────────────────────────────────────────────────────── */
const https  = require('https')
const crypto = require('crypto')
const { authenticateAdmin } = require('../middleware/auth')

const GH_TOKEN  = process.env.GITHUB_TOKEN  || ''
const GH_REPO   = process.env.GITHUB_REPO   || ''
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main'
const GH_FOLDER = 'covers'

function rawUrl(path) {
  const [owner, repo] = GH_REPO.split('/')
  return `https://raw.githubusercontent.com/${owner}/${repo}/${GH_BRANCH}/${path}`
}

function githubUpload(path, base64Content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message: `Add cover: ${path}`, content: base64Content, branch: GH_BRANCH })
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GH_REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'BrandPack-App',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode === 201) resolve(parsed)
          else reject(new Error(parsed.message || `GitHub ${res.statusCode}`))
        } catch { reject(new Error('Parse error')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')))
    req.write(body)
    req.end()
  })
}

/* GET /api/settings/category-covers — PUBLIC */
router.get('/category-covers', async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'categoryCovers' }).lean()
    res.json(setting?.value || {})
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* PUT /api/settings/category-covers — ADMIN
   body: { category: 'Board'|'Bags'|'Autocollants'|'Paper', imageBase64: 'data:image/...' }
*/
router.put('/category-covers', authenticateAdmin, async (req, res) => {
  try {
    const { category, imageBase64 } = req.body
    const allowed = ['Board', 'Bags', 'Autocollants', 'Paper']
    if (!allowed.includes(category)) return res.status(400).json({ message: 'Catégorie invalide' })
    if (!imageBase64) return res.status(400).json({ message: 'imageBase64 requis' })
    if (!GH_TOKEN || !GH_REPO) return res.status(500).json({ message: 'GitHub non configuré' })

    const match = imageBase64.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) return res.status(400).json({ message: 'Format invalide' })
    const ext  = match[1] === 'jpeg' ? 'jpg' : match[1]
    const filename   = `cover-${category.toLowerCase()}-${Date.now()}.${ext}`
    const githubPath = `${GH_FOLDER}/${filename}`

    await githubUpload(githubPath, match[2])
    const url = rawUrl(githubPath)

    // Upsert le document Settings
    const existing = await Settings.findOne({ key: 'categoryCovers' })
    if (existing) {
      existing.value = { ...(existing.value || {}), [category]: url }
      await existing.save()
    } else {
      await Settings.create({ key: 'categoryCovers', value: { [category]: url } })
    }

    res.json({ category, url })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})
