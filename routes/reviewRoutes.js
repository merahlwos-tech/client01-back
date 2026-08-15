const express  = require('express')
const router   = express.Router()
const https    = require('https')
const crypto   = require('crypto')
const Review   = require('../models/Review')
const { authenticateAdmin } = require('../middleware/auth')

/* ─────────────────────────────────────────────────────────────
   GITHUB CONFIG  (variables d'environnement)
   GITHUB_TOKEN   → Personal Access Token (scope: repo)
   GITHUB_REPO    → ex: "username/mon-repo"
   GITHUB_BRANCH  → ex: "main"
   ─────────────────────────────────────────────────────────── */
const GH_TOKEN  = process.env.GITHUB_TOKEN  || ''
const GH_REPO   = process.env.GITHUB_REPO   || ''  // "owner/repo"
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main'
const GH_FOLDER = 'reviews'

/* Construit l'URL raw GitHub (CDN gratuit) */
function rawUrl(path) {
  const [owner, repo] = GH_REPO.split('/')
  return `https://raw.githubusercontent.com/${owner}/${repo}/${GH_BRANCH}/${path}`
}

/* Upload un fichier vers GitHub via l'API Contents */
function githubUpload(path, base64Content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: `Add review image: ${path}`,
      content: base64Content,
      branch:  GH_BRANCH,
    })

    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GH_REPO}/contents/${path}`,
      method:   'PUT',
      headers:  {
        'Authorization': `token ${GH_TOKEN}`,
        'Content-Type':  'application/json',
        'User-Agent':    'BrandPack-App',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode === 201) resolve(parsed)
          else reject(new Error(parsed.message || `GitHub error ${res.statusCode}`))
        } catch { reject(new Error('GitHub response parse error')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('GitHub timeout')))
    req.write(body)
    req.end()
  })
}

/* Supprime un fichier GitHub (nécessite le sha du fichier) */
function githubGetSha(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`,
      method:   'GET',
      headers:  {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent':    'BrandPack-App',
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)?.sha || null) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(8000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

function githubDelete(path, sha) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      message: `Delete review image: ${path}`,
      sha,
      branch: GH_BRANCH,
    })
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GH_REPO}/contents/${path}`,
      method:   'DELETE',
      headers:  {
        'Authorization': `token ${GH_TOKEN}`,
        'Content-Type':  'application/json',
        'User-Agent':    'BrandPack-App',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(10000, () => { req.destroy(); resolve(false) })
    req.write(body)
    req.end()
  })
}

/* ─────────────────────────────────────────────────────────────
   GET /api/reviews
   Route PUBLIQUE — ?category=Board|Bags|Autocollants|Paper
   Sans paramètre → retourne TOUS les avis
   ─────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const filter = {}
    if (req.query.category) filter.category = req.query.category
    const reviews = await Review.find(filter).sort({ createdAt: -1 }).lean()
    res.json(reviews)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   POST /api/reviews
   Route ADMIN — Ajoute un avis (upload image vers GitHub)
   body: {
     imageBase64: "data:image/jpeg;base64,...",
     category: "Board"|"Bags"|"Autocollants"|"Paper"|"general"
   }
   ─────────────────────────────────────────────────────────── */
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const { imageBase64, category = 'Board' } = req.body

    if (!imageBase64) {
      return res.status(400).json({ message: 'imageBase64 requis' })
    }
    if (!GH_TOKEN || !GH_REPO) {
      return res.status(500).json({ message: 'GitHub non configuré (GITHUB_TOKEN, GITHUB_REPO)' })
    }

    // Extrait le base64 pur (sans le préfixe "data:image/...;base64,")
    const match = imageBase64.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) {
      return res.status(400).json({ message: 'Format imageBase64 invalide' })
    }
    const ext        = match[1] === 'jpeg' ? 'jpg' : match[1]
    const pureBase64 = match[2]

    // Génère un nom de fichier unique
    const filename   = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
    const githubPath = `${GH_FOLDER}/${filename}`

    // Upload vers GitHub
    await githubUpload(githubPath, pureBase64)

    // Sauvegarde en BDD
    const review = await Review.create({
      imageUrl:   rawUrl(githubPath),
      category,
      githubPath,
    })

    res.status(201).json(review)
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

/* ─────────────────────────────────────────────────────────────
   DELETE /api/reviews/:id
   Route ADMIN — Supprime un avis (BDD + GitHub)
   ─────────────────────────────────────────────────────────── */
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id)
    if (!review) return res.status(404).json({ message: 'Avis non trouvé' })

    // Suppression depuis GitHub si le chemin est disponible
    if (review.githubPath && GH_TOKEN && GH_REPO) {
      const sha = await githubGetSha(review.githubPath)
      if (sha) await githubDelete(review.githubPath, sha)
    }

    await review.deleteOne()
    res.json({ message: 'Avis supprimé' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

module.exports = router
