require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const TelegramBot = require('node-telegram-bot-api');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

// Import Models
const User = require('./models/User');
const Media = require('./models/Media');
const Purchase = require('./models/Purchase');
const Transaction = require('./models/Transaction');

// Initialize Express
const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname, '../frontend')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log('❌ MongoDB connection error:', err));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Admin IDs from .env
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];

// Temporary upload storage for bot uploads
const tempUploads = {};

// =====================
// AUTHENTICATION MIDDLEWARE
// =====================

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.banned) {
      if (user.bannedUntil && new Date() < user.bannedUntil) {
        return res.status(403).json({ 
          error: 'Account is banned',
          bannedUntil: user.bannedUntil
        });
      } else if (user.bannedUntil && new Date() >= user.bannedUntil) {
        user.banned = false;
        user.bannedUntil = null;
        await user.save();
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const checkAdminPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    if (!req.user.hasPermission(permission)) {
      return res.status(403).json({ error: `Insufficient permissions: ${permission} required` });
    }
    
    next();
  };
};

// =====================
// TELEGRAM BOT COMMANDS
// =====================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    let user = await User.findOne({ telegramId: userId });
    if (!user) {
      const isAdmin = ADMIN_IDS.includes(userId);
      user = new User({
        telegramId: userId,
        username: msg.from.username || '',
        name: msg.from.first_name || '',
        isAdmin: isAdmin,
        adminRole: isAdmin ? 'super_admin' : null
      });
      
      if (isAdmin) {
        user.adminPermissions = User.getAdminPermissions('super_admin');
      }
      
      await user.save();
    }

    const welcomeMessage = `
🎬 *Welcome to Habesha!*

Discover amazing Ethiopian content - videos, photos, and more!

🔍 Browse content
💳 Purchase and unlock
⭐ Save favorites
📱 Watch anytime

Click the button below to open the app!
    `;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Open App', web_app: { url: process.env.APP_URL } }],
          [{ text: 'ℹ️ Help', callback_data: 'help' }],
          ...(user.isAdmin ? [[{ text: '📤 Upload Content', callback_data: 'upload' }]] : [])
        ]
      },
      parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, welcomeMessage, options);
  } catch (error) {
    console.error('Error in /start:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📚 *Help & Support*

How to use Habesha:
1️⃣ Click "Open App" to start
2️⃣ Browse content in Videos & Photos
3️⃣ Tap on content to see details
4️⃣ Purchase to unlock full access
5️⃣ View your purchases in "My Library"

*Admin Commands:*
/upload - Upload new content
/cancel - Cancel current upload

For support: @habesha_support
  `;
  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/profile/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user) {
      return bot.sendMessage(chatId, 'Please start the app first: /start');
    }

    const purchases = await Purchase.find({ userId: user._id });
    const profileMessage = `
👤 *Profile*

Name: ${user.name}
Username: @${user.username || 'Not set'}
Total Purchases: ${purchases.length}
Member Since: ${new Date(user.createdAt).toLocaleDateString()}
${user.isAdmin ? `\n🔑 *Admin:* ${user.adminRole}` : ''}

Click "Open App" to view your library!
    `;

    bot.sendMessage(chatId, profileMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Open App', web_app: { url: process.env.APP_URL } }]
        ]
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error in /profile:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// =====================
// TELEGRAM BOT - ADMIN UPLOAD COMMANDS
// =====================

// Upload command
bot.onText(/\/upload/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user || !user.isAdmin || !user.hasPermission('uploadContent')) {
      return bot.sendMessage(chatId, '❌ You do not have permission to upload content.');
    }

    // Initialize upload state
    tempUploads[userId] = {
      step: 'file',
      data: {}
    };

    const uploadMenu = `
📤 *Upload New Content*

*Step 1 of 4: Send the file*

Please send the video or photo file you want to upload.

Supported formats:
📹 Video: MP4, WebM
🖼️ Photo: JPEG, PNG, GIF

Type /cancel to cancel the upload.
    `;

    bot.sendMessage(chatId, uploadMenu, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error in /upload:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// Cancel upload
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  if (tempUploads[userId]) {
    delete tempUploads[userId];
    bot.sendMessage(chatId, '✅ Upload cancelled.');
  } else {
    bot.sendMessage(chatId, 'ℹ️ No active upload to cancel.');
  }
});

// Handle all messages for upload process
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  // Ignore commands
  if (msg.text && msg.text.startsWith('/')) return;
  
  try {
    // Check if user has active upload
    if (!tempUploads[userId]) return;
    
    const uploadState = tempUploads[userId];
    const user = await User.findOne({ telegramId: userId });
    
    if (!user) return;

    switch (uploadState.step) {
      case 'file':
        await handleFileUpload(msg, user, chatId);
        break;
      case 'title':
        await handleTitleInput(msg, user, chatId);
        break;
      case 'description':
        await handleDescriptionInput(msg, user, chatId);
        break;
      case 'category':
        await handleCategoryInput(msg, user, chatId);
        break;
      case 'price':
        await handlePriceInput(msg, user, chatId);
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// Handle file upload
async function handleFileUpload(msg, user, chatId) {
  const userId = user.telegramId;
  const file = msg.video || msg.photo || msg.document;
  
  if (!file) {
    return bot.sendMessage(chatId, '❌ Please send a valid video or photo file.');
  }

  try {
    let fileId, fileType, fileName, mimeType;
    
    // Determine file type
    if (msg.video) {
      fileId = msg.video.file_id;
      fileType = 'video';
      mimeType = msg.video.mime_type || 'video/mp4';
      fileName = `video_${Date.now()}.mp4`;
    } else if (msg.photo) {
      // Get the largest photo
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileType = 'photo';
      mimeType = 'image/jpeg';
      fileName = `photo_${Date.now()}.jpg`;
    } else if (msg.document) {
      const doc = msg.document;
      const mimeType = doc.mime_type || '';
      if (mimeType.startsWith('video/')) {
        fileId = doc.file_id;
        fileType = 'video';
        fileName = doc.file_name || `video_${Date.now()}.mp4`;
      } else if (mimeType.startsWith('image/')) {
        fileId = doc.file_id;
        fileType = 'photo';
        fileName = doc.file_name || `photo_${Date.now()}.jpg`;
      } else {
        return bot.sendMessage(chatId, '❌ Unsupported file type. Please send a video or photo.');
      }
    } else {
      return bot.sendMessage(chatId, '❌ Unsupported file type. Please send a video or photo.');
    }

    // Get file from Telegram
    const fileLink = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileLink.file_path}`;

    // Download file
    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream'
    });

    // Save file locally
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const uniqueFilename = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(fileName);
    const filePath = path.join(uploadDir, uniqueFilename);
    
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Store file info in temp
    tempUploads[userId].data = {
      ...tempUploads[userId].data,
      file: uniqueFilename,
      fileType: fileType,
      fileName: fileName
    };

    // Move to next step
    tempUploads[userId].step = 'title';
    
    const titlePrompt = `
✅ File received successfully!

*Step 2 of 4: Enter Title*

Please send the title for this content.

Example: "Amazing Ethiopian Music Video"

Type /cancel to cancel the upload.
    `;
    
    bot.sendMessage(chatId, titlePrompt, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('File download error:', error);
    bot.sendMessage(chatId, '❌ Failed to download file. Please try again.');
    delete tempUploads[userId];
  }
}

// Handle title input
async function handleTitleInput(msg, user, chatId) {
  const userId = user.telegramId;
  const title = msg.text;
  
  if (!title || title.length < 3) {
    return bot.sendMessage(chatId, '❌ Title must be at least 3 characters long. Please try again.');
  }

  tempUploads[userId].data.title = title;
  tempUploads[userId].step = 'description';

  const descPrompt = `
✅ Title saved: *${title}*

*Step 3 of 4: Enter Description*

Please send a description for this content.

Example: "This is an amazing video about Ethiopian culture..."

Type /cancel to cancel the upload.
  `;
  
  bot.sendMessage(chatId, descPrompt, { parse_mode: 'Markdown' });
}

// Handle description input
async function handleDescriptionInput(msg, user, chatId) {
  const userId = user.telegramId;
  const description = msg.text;
  
  tempUploads[userId].data.description = description || '';
  tempUploads[userId].step = 'category';

  const categoryPrompt = `
✅ Description saved!

*Step 4 of 6: Select Category*

Please choose a category by sending the number:

1️⃣ Music
2️⃣ Movies
3️⃣ Sports
4️⃣ Culture
5️⃣ News

Type /cancel to cancel the upload.
  `;
  
  bot.sendMessage(chatId, categoryPrompt, { parse_mode: 'Markdown' });
}

// Handle category input
async function handleCategoryInput(msg, user, chatId) {
  const userId = user.telegramId;
  const input = msg.text;
  
  const categories = {
    '1': 'music',
    '2': 'movies',
    '3': 'sports',
    '4': 'culture',
    '5': 'news'
  };

  const category = categories[input];
  
  if (!category) {
    return bot.sendMessage(chatId, '❌ Invalid category. Please send a number from 1 to 5.');
  }

  tempUploads[userId].data.category = category;
  tempUploads[userId].step = 'price';

  const pricePrompt = `
✅ Category selected: *${category}*

*Step 5 of 6: Enter Price*

Please enter the price in USD:

💰 Enter a number (e.g., 5.99)
🆓 Enter 0 for free content

Type /cancel to cancel the upload.
  `;
  
  bot.sendMessage(chatId, pricePrompt, { parse_mode: 'Markdown' });
}

// Handle price input
async function handlePriceInput(msg, user, chatId) {
  const userId = user.telegramId;
  const input = msg.text;
  
  const price = parseFloat(input);
  
  if (isNaN(price) || price < 0) {
    return bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number (e.g., 5.99).');
  }

  tempUploads[userId].data.price = price;
  tempUploads[userId].step = 'confirm';

  // Show confirmation
  const data = tempUploads[userId].data;
  const confirmMessage = `
📋 *Review Your Upload*

Please review the information below:

📌 *Title:* ${data.title}
📝 *Description:* ${data.description || 'No description'}
📂 *Type:* ${data.fileType}
🏷️ *Category:* ${data.category}
💰 *Price:* $${price.toFixed(2)}

Is this information correct?

Press ✅ Yes to confirm and upload
Press ❌ No to cancel

Type /cancel to cancel the upload.
  `;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Yes, Upload', callback_data: 'confirm_upload' },
          { text: '❌ No, Cancel', callback_data: 'cancel_upload' }
        ]
      ]
    },
    parse_mode: 'Markdown'
  };

  bot.sendMessage(chatId, confirmMessage, options);
}

// Handle callback queries for upload confirmation
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;

  if (data === 'help') {
    const helpMessage = `
📚 *Help & Support*

How to use Habesha:
1️⃣ Click "Open App" to start
2️⃣ Browse content in Videos & Photos
3️⃣ Tap on content to see details
4️⃣ Purchase to unlock full access
5️⃣ View your purchases in "My Library"

*Admin Commands:*
/upload - Upload new content
/cancel - Cancel current upload

For support: @habesha_support
    `;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'upload') {
    // Trigger upload command
    bot.emit('text', { chat: { id: chatId }, from: { id: userId }, text: '/upload' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Handle upload confirmation
  if (data === 'confirm_upload') {
    await confirmUpload(userId, chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'cancel_upload') {
    if (tempUploads[userId]) {
      delete tempUploads[userId];
      bot.sendMessage(chatId, '❌ Upload cancelled.');
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// Confirm and save upload
async function confirmUpload(userId, chatId) {
  try {
    if (!tempUploads[userId]) {
      return bot.sendMessage(chatId, '❌ No upload in progress.');
    }

    const data = tempUploads[userId].data;
    const user = await User.findOne({ telegramId: userId });

    if (!user) {
      return bot.sendMessage(chatId, '❌ User not found.');
    }

    // Create media in database
    const media = new Media({
      title: data.title,
      description: data.description || '',
      type: data.fileType,
      category: data.category,
      price: data.price,
      file: data.file,
      thumbnail: data.file,
      uploadedBy: user._id,
      isPublished: true
    });

    await media.save();

    // Clear temp upload
    delete tempUploads[userId];

    // Success message
    const successMessage = `
✅ *Upload Successful!*

Your content has been uploaded successfully.

📌 *Title:* ${data.title}
📂 *Type:* ${data.fileType}
🏷️ *Category:* ${data.category}
💰 *Price:* $${data.price.toFixed(2)}

The content is now available in the app!

Click the button below to view it in the app.
    `;

    const options = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Open App', web_app: { url: process.env.APP_URL } }]
        ]
      },
      parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, successMessage, options);

    // Notify all admins about new upload
    const admins = await User.find({ isAdmin: true });
    for (const admin of admins) {
      try {
        await bot.sendMessage(admin.telegramId,
          `📹 *New Content Uploaded*\n\n` +
          `📌 Title: ${data.title}\n` +
          `📂 Type: ${data.fileType}\n` +
          `🏷️ Category: ${data.category}\n` +
          `💰 Price: $${data.price.toFixed(2)}\n` +
          `👤 Uploaded by: ${user.name}\n\n` +
          `View in app: ${process.env.APP_URL}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Failed to notify admin:', error);
      }
    }

  } catch (error) {
    console.error('Confirm upload error:', error);
    bot.sendMessage(chatId, '❌ Failed to save upload. Please try again.');
    delete tempUploads[userId];
  }
}

// =====================
// ROOT ROUTE
// =====================

app.get('/', (req, res) => {
  res.json({
    name: 'Habesha API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: '/api/auth/telegram',
      media: '/api/media',
      purchases: '/api/purchases',
      admin: '/api/admin',
      docs: '/api/docs'
    }
  });
});

// API Documentation Route
app.get('/api/docs', (req, res) => {
  res.json({
    endpoints: {
      'POST /api/auth/telegram': 'Authenticate user with Telegram',
      'GET /api/media': 'Get all media content',
      'GET /api/media/:id': 'Get single media by ID',
      'POST /api/purchase/initiate': 'Initiate purchase',
      'POST /api/purchase/verify': 'Verify payment',
      'GET /api/purchases': 'Get user purchases',
      'POST /api/admin/media': 'Upload media (Admin)',
      'PUT /api/admin/media/:id': 'Update media (Admin)',
      'DELETE /api/admin/media/:id': 'Delete media (Admin)',
      'GET /api/admin/stats': 'Get admin stats (Admin)',
      'GET /api/admin/users': 'Get users (Admin)',
      'PUT /api/admin/users/:userId/ban': 'Ban/Unban user (Admin)',
      'GET /api/admin/admins': 'Get all admins (Admin)',
      'POST /api/admin/admins': 'Add admin (Admin)',
      'PUT /api/admin/admins/:adminId': 'Update admin (Admin)',
      'DELETE /api/admin/admins/:adminId': 'Remove admin (Admin)',
      'POST /api/admin/broadcast': 'Send broadcast (Admin)'
    },
    admin_roles: {
      super_admin: 'Full access to everything',
      content_manager: 'Manage content and view analytics',
      moderator: 'Delete and edit content',
      support: 'Manage users only'
    }
  });
});

// =====================
// AUTH ENDPOINTS
// =====================

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { telegramId, username, name } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    let user = await User.findOne({ telegramId });
    if (!user) {
      const isAdmin = ADMIN_IDS.includes(telegramId);
      user = new User({
        telegramId,
        username: username || '',
        name: name || 'User',
        isAdmin: isAdmin,
        adminRole: isAdmin ? 'super_admin' : null
      });
      
      if (isAdmin) {
        user.adminPermissions = User.getAdminPermissions('super_admin');
      }
      
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        isAdmin: user.isAdmin,
        adminRole: user.adminRole,
        permissions: user.adminPermissions
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// =====================
// ADMIN MANAGEMENT ENDPOINTS
// =====================

app.get('/api/admin/admins', authenticate, checkAdminPermission('manageAdmins'), async (req, res) => {
  try {
    const admins = await User.find({ isAdmin: true })
      .select('-__v')
      .sort({ createdAt: -1 });
    
    res.json(admins);
  } catch (error) {
    console.error('Error fetching admins:', error);
    res.status(500).json({ error: 'Failed to fetch admins' });
  }
});

app.post('/api/admin/admins', authenticate, checkAdminPermission('manageAdmins'), async (req, res) => {
  try {
    const { telegramId, name, role, customPermissions } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    let user = await User.findOne({ telegramId });
    
    if (!user) {
      user = new User({
        telegramId,
        username: req.body.username || '',
        name: name || 'Admin User',
        isAdmin: true,
        adminRole: role || 'content_manager'
      });
    } else {
      user.isAdmin = true;
      user.adminRole = role || 'content_manager';
    }
    
    const defaultPermissions = User.getAdminPermissions(user.adminRole);
    user.adminPermissions = customPermissions || defaultPermissions;
    
    await user.save();
    
    try {
      await bot.sendMessage(telegramId, 
        `🎉 You have been made an admin on Habesha!\n\n` +
        `Role: ${user.adminRole}\n` +
        `Permissions: ${Object.keys(user.adminPermissions).filter(p => user.adminPermissions[p]).join(', ')}\n\n` +
        `Open the app to access admin features.`
      );
    } catch (error) {
      console.error('Failed to notify new admin:', error);
    }
    
    const superAdmins = await User.find({ adminRole: 'super_admin' });
    for (const admin of superAdmins) {
      try {
        await bot.sendMessage(admin.telegramId,
          `👤 New admin added\n` +
          `User: ${user.name} (@${user.username})\n` +
          `Role: ${user.adminRole}\n` +
          `Added by: ${req.user.name}`
        );
      } catch (error) {
        console.error('Failed to notify super admin:', error);
      }
    }
    
    res.status(201).json({
      success: true,
      message: 'Admin added successfully',
      admin: user
    });
  } catch (error) {
    console.error('Error adding admin:', error);
    res.status(500).json({ error: 'Failed to add admin' });
  }
});

app.put('/api/admin/admins/:adminId', authenticate, checkAdminPermission('manageAdmins'), async (req, res) => {
  try {
    const { adminId } = req.params;
    const { role, permissions } = req.body;
    
    if (adminId === req.user._id.toString() && role !== 'super_admin') {
      return res.status(400).json({ error: 'Cannot demote yourself' });
    }
    
    const admin = await User.findById(adminId);
    if (!admin || !admin.isAdmin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    
    if (admin.adminRole === 'super_admin' && req.user.adminRole !== 'super_admin') {
      return res.status(403).json({ error: 'Cannot modify super admin' });
    }
    
    if (role) {
      admin.adminRole = role;
      const defaultPermissions = User.getAdminPermissions(role);
      admin.adminPermissions = permissions || defaultPermissions;
    } else if (permissions) {
      admin.adminPermissions = permissions;
    }
    
    await admin.save();
    
    try {
      await bot.sendMessage(admin.telegramId,
        `🔄 Your admin permissions have been updated\n\n` +
        `Role: ${admin.adminRole}\n` +
        `Permissions: ${Object.keys(admin.adminPermissions).filter(p => admin.adminPermissions[p]).join(', ')}`
      );
    } catch (error) {
      console.error('Failed to notify admin:', error);
    }
    
    res.json({
      success: true,
      message: 'Admin updated successfully',
      admin
    });
  } catch (error) {
    console.error('Error updating admin:', error);
    res.status(500).json({ error: 'Failed to update admin' });
  }
});

app.delete('/api/admin/admins/:adminId', authenticate, checkAdminPermission('manageAdmins'), async (req, res) => {
  try {
    const { adminId } = req.params;
    
    if (adminId === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }
    
    const admin = await User.findById(adminId);
    if (!admin || !admin.isAdmin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    
    if (admin.adminRole === 'super_admin' && req.user.adminRole !== 'super_admin') {
      return res.status(403).json({ error: 'Cannot remove super admin' });
    }
    
    admin.isAdmin = false;
    admin.adminRole = null;
    admin.adminPermissions = {};
    await admin.save();
    
    try {
      await bot.sendMessage(admin.telegramId,
        `⚠️ Your admin privileges have been removed from Habesha.\n\n` +
        `You can still use the app as a regular user.`
      );
    } catch (error) {
      console.error('Failed to notify removed admin:', error);
    }
    
    res.json({
      success: true,
      message: 'Admin removed successfully'
    });
  } catch (error) {
    console.error('Error removing admin:', error);
    res.status(500).json({ error: 'Failed to remove admin' });
  }
});

// =====================
// USER MANAGEMENT ENDPOINTS
// =====================

app.get('/api/admin/users', authenticate, checkAdminPermission('manageUsers'), async (req, res) => {
  try {
    const { search, isAdmin, banned, limit = 50, skip = 0 } = req.query;
    
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { telegramId: { $regex: search, $options: 'i' } }
      ];
    }
    if (isAdmin !== undefined) query.isAdmin = isAdmin === 'true';
    if (banned !== undefined) query.banned = banned === 'true';
    
    const users = await User.find(query)
      .select('-__v')
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(query);
    
    res.json({
      users,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip)
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.put('/api/admin/users/:userId/ban', authenticate, checkAdminPermission('manageUsers'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { ban, duration = 7, reason = '' } = req.body;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.isAdmin) {
      return res.status(400).json({ error: 'Cannot ban an admin' });
    }
    
    user.banned = ban;
    if (ban) {
      user.bannedUntil = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
    } else {
      user.bannedUntil = null;
    }
    await user.save();
    
    try {
      if (ban) {
        await bot.sendMessage(user.telegramId,
          `⛔ You have been banned from Habesha\n\n` +
          `Reason: ${reason || 'Violation of terms of service'}\n` +
          `Duration: ${duration} days\n` +
          `Until: ${user.bannedUntil.toLocaleDateString()}\n\n` +
          `Contact support for more information.`
        );
      } else {
        await bot.sendMessage(user.telegramId,
          `✅ Your account has been unbanned\n\n` +
          `You can now access Habesha again.`
        );
      }
    } catch (error) {
      console.error('Failed to notify user:', error);
    }
    
    res.json({
      success: true,
      message: `User ${ban ? 'banned' : 'unbanned'} successfully`,
      user
    });
  } catch (error) {
    console.error('Error toggling user ban:', error);
    res.status(500).json({ error: 'Failed to toggle user ban' });
  }
});

// =====================
// MEDIA ENDPOINTS
// =====================

app.get('/api/media', async (req, res) => {
  try {
    const { type, category, search } = req.query;
    const query = { isPublished: true };
    
    if (type) query.type = type;
    if (category) query.category = category;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const media = await Media.find(query)
      .sort({ createdAt: -1 })
      .limit(50);

    const userId = req.user?._id;
    const mediaWithStatus = await Promise.all(media.map(async (item) => {
      const isPurchased = userId ? await Purchase.findOne({ 
        userId, 
        mediaId: item._id,
        status: 'completed'
      }) : false;

      return {
        ...item.toObject(),
        isPurchased: !!isPurchased,
        isFree: item.price === 0
      };
    }));

    res.json(mediaWithStatus);
  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

app.get('/api/media/:id', async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    media.views += 1;
    await media.save();

    const userId = req.user?._id;
    let isPurchased = false;
    
    if (userId) {
      const purchase = await Purchase.findOne({
        userId,
        mediaId: media._id,
        status: 'completed'
      });
      isPurchased = !!purchase;
    }

    res.json({
      ...media.toObject(),
      isPurchased,
      isFree: media.price === 0
    });
  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

// =====================
// CONTENT MANAGEMENT ENDPOINTS (Admin)
// =====================

app.post('/api/admin/media', authenticate, checkAdminPermission('uploadContent'), upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, category, price } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const media = new Media({
      title,
      description,
      type,
      category,
      price: parseFloat(price) || 0,
      file: req.file.filename,
      thumbnail: req.file.filename,
      uploadedBy: req.user._id
    });

    await media.save();

    // Notify all admins
    const admins = await User.find({ isAdmin: true });
    for (const admin of admins) {
      try {
        await bot.sendMessage(admin.telegramId, 
          `📹 New content uploaded\n` +
          `Title: ${title}\n` +
          `Type: ${type}\n` +
          `Category: ${category}\n` +
          `Price: $${price || 0}\n` +
          `Uploaded by: ${req.user.name}`
        );
      } catch (error) {
        console.error('Failed to notify admin:', error);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Content uploaded successfully',
      media
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.put('/api/admin/media/:id', authenticate, checkAdminPermission('editContent'), async (req, res) => {
  try {
    const { title, description, price, isPublished } = req.body;
    const media = await Media.findByIdAndUpdate(
      req.params.id,
      { title, description, price, isPublished },
      { new: true }
    );

    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    res.json({
      success: true,
      message: 'Content updated successfully',
      media
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/api/admin/media/:id', authenticate, checkAdminPermission('deleteContent'), async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    if (media.file) {
      const filePath = path.join(__dirname, 'uploads', media.file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await media.remove();
    res.json({
      success: true,
      message: 'Content deleted successfully'
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// =====================
// PURCHASE ENDPOINTS
// =====================

app.post('/api/purchase/initiate', authenticate, async (req, res) => {
  try {
    const { mediaId } = req.body;
    const userId = req.user._id;

    const media = await Media.findById(mediaId);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const existingPurchase = await Purchase.findOne({
      userId,
      mediaId,
      status: 'completed'
    });

    if (existingPurchase) {
      return res.status(400).json({ error: 'Already purchased' });
    }

    if (media.price === 0) {
      const purchase = new Purchase({
        userId,
        mediaId,
        amount: 0,
        status: 'completed',
        paymentId: 'free_' + Date.now()
      });
      await purchase.save();

      await User.findByIdAndUpdate(userId, {
        $addToSet: { purchases: mediaId }
      });

      const admins = await User.find({ isAdmin: true });
      for (const admin of admins) {
        try {
          await bot.sendMessage(admin.telegramId, 
            `📥 Free content accessed\n` +
            `User: ${req.user.name}\n` +
            `Content: ${media.title}`
          );
        } catch (error) {
          console.error('Failed to notify admin:', error);
        }
      }

      return res.json({ success: true, free: true });
    }

    const purchase = new Purchase({
      userId,
      mediaId,
      amount: media.price,
      status: 'pending',
      paymentId: 'pending_' + Date.now()
    });
    await purchase.save();

    const paymentUrl = `${process.env.APP_URL}/payment/${purchase._id}`;

    res.json({
      purchaseId: purchase._id,
      amount: media.price,
      paymentUrl
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ error: 'Purchase failed' });
  }
});

app.post('/api/purchase/verify', authenticate, async (req, res) => {
  try {
    const { purchaseId, paymentId } = req.body;
    const userId = req.user._id;

    const purchase = await Purchase.findOne({ _id: purchaseId, userId });
    if (!purchase) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    if (purchase.status === 'completed') {
      return res.json({ success: true });
    }

    // Simulate payment verification
    const isVerified = true;

    if (isVerified) {
      purchase.status = 'completed';
      purchase.paymentId = paymentId || 'verified_' + Date.now();
      await purchase.save();

      await User.findByIdAndUpdate(userId, {
        $addToSet: { purchases: purchase.mediaId }
      });

      const admins = await User.find({ isAdmin: true });
      for (const admin of admins) {
        try {
          const media = await Media.findById(purchase.mediaId);
          await bot.sendMessage(admin.telegramId, 
            `💰 New purchase\n` +
            `User: ${req.user.name}\n` +
            `Content: ${media.title}\n` +
            `Amount: $${purchase.amount}`
          );
        } catch (error) {
          console.error('Failed to notify admin:', error);
        }
      }

      res.json({ success: true });
    } else {
      purchase.status = 'failed';
      await purchase.save();
      res.status(400).json({ error: 'Payment verification failed' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.get('/api/purchases', authenticate, async (req, res) => {
  try {
    const purchases = await Purchase.find({
      userId: req.user._id,
      status: 'completed'
    }).populate('mediaId').sort({ createdAt: -1 });

    res.json(purchases);
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: 'Failed to fetch purchases' });
  }
});

// =====================
// STATS ENDPOINTS
// =====================

app.get('/api/admin/stats', authenticate, checkAdminPermission('viewAnalytics'), async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalMedia = await Media.countDocuments();
    const totalPurchases = await Purchase.countDocuments({ status: 'completed' });
    const totalEarnings = await Purchase.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const recentPurchases = await Purchase.find({ status: 'completed' })
      .populate('userId', 'name username')
      .populate('mediaId', 'title')
      .sort({ createdAt: -1 })
      .limit(10);

    const topContent = await Media.find()
      .sort({ views: -1 })
      .limit(5);

    const adminCount = await User.countDocuments({ isAdmin: true });

    res.json({
      totalUsers,
      totalMedia,
      totalPurchases,
      totalEarnings: totalEarnings[0]?.total || 0,
      recentPurchases,
      topContent,
      adminCount
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// =====================
// BROADCAST ENDPOINTS
// =====================

app.post('/api/admin/broadcast', authenticate, checkAdminPermission('broadcastMessages'), async (req, res) => {
  try {
    const { message, targetUsers = 'all', targetAdmins = false } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const query = { banned: false };
    if (targetAdmins) {
      query.isAdmin = true;
    }
    
    const users = await User.find(query);
    let sentCount = 0;

    for (const user of users) {
      try {
        await bot.sendMessage(user.telegramId, 
          `📢 Announcement from Habesha\n\n${message}`
        );
        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Failed to send to user ${user.telegramId}:`, error);
      }
    }

    res.json({ 
      success: true, 
      sentCount,
      totalTargeted: users.length
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ error: 'Broadcast failed' });
  }
});

// =====================
// 404 HANDLER
// =====================

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    message: 'Please check the API documentation at /api/docs'
  });
});

// =====================
// ERROR HANDLING
// =====================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// =====================
// START SERVER
// =====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Habesha Server running on port ${PORT}`);
  console.log(`📊 Admin IDs: ${ADMIN_IDS.join(', ')}`);
  console.log(`📝 API Docs: http://localhost:${PORT}/api/docs`);
  console.log(`🏠 Home: http://localhost:${PORT}`);
  console.log(`🤖 Bot is running...`);
});
