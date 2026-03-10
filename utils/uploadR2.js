// utils/uploadR2.js
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const sharp  = require('sharp')
const crypto = require('crypto')

const r2 = new S3Client({
  region:   'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const BUCKET     = process.env.R2_BUCKET_NAME
const PUBLIC_URL = process.env.R2_PUBLIC_URL

/**
 * Upload un buffer image vers R2
 * Convertit en WebP 1200px max pour optimiser la taille
 * Retourne l'URL publique
 */
async function uploadProductImageToR2(fileBuffer) {
  const key = `products/${crypto.randomUUID()}.webp`

  const optimized = await sharp(fileBuffer)
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer()

  await r2.send(new PutObjectCommand({
    Bucket:       BUCKET,
    Key:          key,
    Body:         optimized,
    ContentType:  'image/webp',
    CacheControl: 'public, max-age=31536000',
  }))

  return `${PUBLIC_URL}/${key}`
}

/**
 * Supprime une image R2 depuis son URL publique
 */
async function deleteProductImageFromR2(url) {
  try {
    if (!url || !url.startsWith(PUBLIC_URL)) return
    const key = url.replace(`${PUBLIC_URL}/`, '')
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.error('R2 delete error:', err)
  }
}

module.exports = { uploadProductImageToR2, deleteProductImageFromR2 }