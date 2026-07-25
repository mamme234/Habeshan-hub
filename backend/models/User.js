const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true
  },
  username: {
    type: String,
    default: ''
  },
  name: {
    type: String,
    required: true
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  purchases: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media'
  }],
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);
