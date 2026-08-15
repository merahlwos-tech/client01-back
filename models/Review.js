const mongoose = require('mongoose')

const reviewSchema = new mongoose.Schema(
  {
    imageUrl:   { type: String, required: true },
    category:   {
      type:    String,
      enum:    ['Board', 'Bags', 'Autocollants', 'Paper'],
      default: 'Board',
    },
    githubPath: { type: String, default: '' }, // chemin dans le repo GitHub (pour suppression)
  },
  { timestamps: true }
)

module.exports = mongoose.model('Review', reviewSchema)
