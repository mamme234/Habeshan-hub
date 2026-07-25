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
  adminRole: {
    type: String,
    enum: ['super_admin', 'content_manager', 'moderator', 'support', null],
    default: null
  },
  adminPermissions: {
    uploadContent: { type: Boolean, default: false },
    deleteContent: { type: Boolean, default: false },
    editContent: { type: Boolean, default: false },
    manageUsers: { type: Boolean, default: false },
    manageAdmins: { type: Boolean, default: false },
    viewAnalytics: { type: Boolean, default: false },
    broadcastMessages: { type: Boolean, default: false },
    managePayments: { type: Boolean, default: false }
  },
  purchases: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media'
  }],
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Media'
  }],
  banned: {
    type: Boolean,
    default: false
  },
  bannedUntil: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
});

userSchema.statics.getAdminPermissions = function(role) {
  const permissions = {
    super_admin: {
      uploadContent: true,
      deleteContent: true,
      editContent: true,
      manageUsers: true,
      manageAdmins: true,
      viewAnalytics: true,
      broadcastMessages: true,
      managePayments: true
    },
    content_manager: {
      uploadContent: true,
      deleteContent: true,
      editContent: true,
      manageUsers: false,
      manageAdmins: false,
      viewAnalytics: true,
      broadcastMessages: false,
      managePayments: false
    },
    moderator: {
      uploadContent: false,
      deleteContent: true,
      editContent: true,
      manageUsers: false,
      manageAdmins: false,
      viewAnalytics: false,
      broadcastMessages: false,
      managePayments: false
    },
    support: {
      uploadContent: false,
      deleteContent: false,
      editContent: false,
      manageUsers: true,
      manageAdmins: false,
      viewAnalytics: false,
      broadcastMessages: false,
      managePayments: false
    }
  };
  return permissions[role] || permissions.super_admin;
};

userSchema.methods.hasPermission = function(permission) {
  if (!this.isAdmin) return false;
  if (this.adminRole === 'super_admin') return true;
  return this.adminPermissions[permission] === true;
};

module.exports = mongoose.model('User', userSchema);
