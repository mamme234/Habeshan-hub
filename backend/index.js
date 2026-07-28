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
const AdminConfig = require('./models/AdminConfig');

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

// Temporary storage
const tempUploads = {};
const tempTelebirrConfig = {};

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

    let adminButtons = [];
    if (user.isAdmin) {
      adminButtons = [
        [{ text: '📤 Upload Content', callback_data: 'upload' }],
        [{ text: '📱 Set Telebirr', callback_data: 'setuptelebirr' }]
      ];
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
          ...adminButtons
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
/setuptelebirr - Set up Telebirr configuration
/viewtelebirr - View your Telebirr configuration
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
// TELEGRAM BOT - UPLOAD SYSTEM
// =====================

bot.onText(/\/upload/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user || !user.isAdmin || !user.hasPermission('uploadContent')) {
      return bot.sendMessage(chatId, '❌ You do not have permission to upload content.');
    }

    tempUploads[userId] = {
      step: 'file',
      data: {}
    };

    const uploadMenu = `
📤 *Upload New Content*

*Step 1 of 6: Send the file*

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

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  if (tempUploads[userId]) {
    delete tempUploads[userId];
    bot.sendMessage(chatId, '✅ Upload cancelled.');
  } else if (tempTelebirrConfig[userId]) {
    delete tempTelebirrConfig[userId];
    bot.sendMessage(chatId, '✅ Telebirr setup cancelled.');
  } else {
    bot.sendMessage(chatId, 'ℹ️ No active operation to cancel.');
  }
});

// Handle messages for upload and Telebirr setup
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  if (msg.text && msg.text.startsWith('/')) return;
  
  try {
    // Check for upload
    if (tempUploads[userId]) {
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
      return;
    }

    // Check for Telebirr setup
    if (tempTelebirrConfig[userId]) {
      const config = tempTelebirrConfig[userId];
      
      switch (config.step) {
        case 'number':
          await handleTelebirrNumber(msg, userId, chatId);
          break;
        case 'password':
          await handleTelebirrPassword(msg, userId, chatId);
          break;
      }
      return;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// =====================
// UPLOAD HANDLERS
// =====================

async function handleFileUpload(msg, user, chatId) {
  const userId = user.telegramId;
  const file = msg.video || msg.photo || msg.document;
  
  if (!file) {
    return bot.sendMessage(chatId, '❌ Please send a valid video or photo file.');
  }

  try {
    let fileId, fileType, fileName, mimeType;
    
    if (msg.video) {
      fileId = msg.video.file_id;
      fileType = 'video';
      mimeType = msg.video.mime_type || 'video/mp4';
      fileName = `video_${Date.now()}.mp4`;
    } else if (msg.photo) {
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

    const fileLink = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileLink.file_path}`;

    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream'
    });

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

    tempUploads[userId].data = {
      ...tempUploads[userId].data,
      file: uniqueFilename,
      fileType: fileType,
      fileName: fileName
    };

    tempUploads[userId].step = 'title';
    
    const titlePrompt = `
✅ File received successfully!

*Step 2 of 6: Enter Title*

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

*Step 3 of 6: Enter Description*

Please send a description for this content.

Example: "This is an amazing video about Ethiopian culture..."

Type /cancel to cancel the upload.
  `;
  
  bot.sendMessage(chatId, descPrompt, { parse_mode: 'Markdown' });
}

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

async function handlePriceInput(msg, user, chatId) {
  const userId = user.telegramId;
  const input = msg.text;
  
  const price = parseFloat(input);
  
  if (isNaN(price) || price < 0) {
    return bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number.');
  }

  tempUploads[userId].data.price = price;
  tempUploads[userId].step = 'confirm';

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

// =====================
// TELEBIRR CONFIGURATION HANDLERS
// =====================

bot.onText(/\/setuptelebirr/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user || !user.isAdmin) {
      return bot.sendMessage(chatId, '❌ Only admins can set up Telebirr configuration.');
    }

    const existingConfig = await AdminConfig.findOne({ telegramId: userId });
    
    if (existingConfig) {
      const statusEmoji = existingConfig.status === 'approved' ? '✅' : 
                          existingConfig.status === 'rejected' ? '❌' : '⏳';
      
      const confirmMessage = `
⚠️ *You already have a Telebirr configuration.*

📱 *Number:* ${existingConfig.telebirrNumber}
🔐 *Password:* ${'•'.repeat(existingConfig.telebirrPassword.length)}
📊 *Status:* ${statusEmoji} ${existingConfig.status.toUpperCase()}

Do you want to update your configuration?

Press ✅ Yes to update
Press ❌ No to keep current
      `;

      const options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Yes, Update', callback_data: 'update_telebirr' },
              { text: '❌ No, Keep', callback_data: 'keep_telebirr' }
            ]
          ]
        },
        parse_mode: 'Markdown'
      };

      return bot.sendMessage(chatId, confirmMessage, options);
    }

    tempTelebirrConfig[userId] = {
      step: 'number',
      data: {}
    };

    const setupMessage = `
📱 *Telebirr Configuration Setup*

*Step 1 of 2: Enter Telebirr Number*

Please enter your Telebirr phone number.

Format: 09XXXXXXXX

⚠️ *Note:* Your configuration will be verified. You will receive a confirmation message after approval.

Type /cancel to cancel the setup.
    `;

    bot.sendMessage(chatId, setupMessage, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error in /setuptelebirr:', error);
    bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

async function handleTelebirrNumber(msg, userId, chatId) {
  const number = msg.text;
  
  const phoneRegex = /^09\d{8}$/;
  if (!phoneRegex.test(number)) {
    return bot.sendMessage(chatId, '❌ Invalid phone number. Please use format: 09XXXXXXXX');
  }

  tempTelebirrConfig[userId].data.number = number;
  tempTelebirrConfig[userId].step = 'password';

  const passwordMessage = `
🔐 *Step 2 of 2: Enter Telebirr Password*

Please enter your Telebirr account password.

⚠️ *Note:* Your password is encrypted and will be verified. You will receive confirmation after approval.

Type /cancel to cancel the setup.
  `;

  bot.sendMessage(chatId, passwordMessage, { parse_mode: 'Markdown' });
}

async function handleTelebirrPassword(msg, userId, chatId) {
  const password = msg.text;
  
  if (!password || password.length < 4) {
    return bot.sendMessage(chatId, '❌ Password must be at least 4 characters long.');
  }

  const user = await User.findOne({ telegramId: userId });
  
  const config = new AdminConfig({
    adminId: user._id,
    telegramId: userId,
    adminName: user.name,
    telebirrNumber: tempTelebirrConfig[userId].data.number,
    telebirrPassword: password,
    status: 'pending'
  });

  await config.save();

  delete tempTelebirrConfig[userId];

  // Notify the admin (not telling them about main admin)
  const successMessage = `
✅ *Telebirr Configuration Submitted!*

📱 *Number:* ${config.telebirrNumber}
📊 *Status:* ⏳ Pending Verification

You will receive a confirmation message once your configuration is verified.

Thank you for your patience! 🙏
  `;

  bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

  // Notify ALL super admins (hidden from regular admin)
  const superAdmins = await User.find({ adminRole: 'super_admin' });
  
  for (const superAdmin of superAdmins) {
    try {
      const approveOptions = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `approve_telebirr_${config._id}` },
              { text: '❌ Reject', callback_data: `reject_telebirr_${config._id}` }
            ]
          ]
        },
        parse_mode: 'Markdown'
      };

      await bot.sendMessage(
        superAdmin.telegramId,
        `🔔 *New Telebirr Configuration Request*

👤 *Admin:* ${user.name} (@${user.username || 'N/A'})
📱 *Telegram ID:* ${userId}
📞 *Telebirr Number:* ${config.telebirrNumber}
🔐 *Password:* ${'•'.repeat(config.telebirrPassword.length)}
📅 *Requested:* ${new Date().toLocaleString()}

Please review and approve or reject this configuration.`,
        approveOptions
      );
    } catch (error) {
      console.error('Failed to notify super admin:', error);
    }
  }
}

bot.onText(/\/viewtelebirr/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    const user = await User.findOne({ telegramId: userId });
    if (!user || !user.isAdmin) {
      return bot.sendMessage(chatId, '❌ Only admins can view Telebirr configuration.');
    }

    const config = await AdminConfig.findOne({ telegramId: userId });
    
    if (!config) {
      return bot.sendMessage(chatId, 
        `ℹ️ You haven't set up Telebirr configuration yet.\n\n` +
        `Use /setuptelebirr to set up your configuration.`
      );
    }

    const statusEmoji = config.status === 'approved' ? '✅' : 
                        config.status === 'rejected' ? '❌' : '⏳';

    const viewMessage = `
📱 *Your Telebirr Configuration*

📞 *Number:* ${config.telebirrNumber}
🔐 *Password:* ${'•'.repeat(config.telebirrPassword.length)}
📊 *Status:* ${statusEmoji} ${config.status.toUpperCase()}
${config.status === 'approved' ? '✅ Active and ready to use' : ''}
${config.status === 'pending' ? '⏳ Waiting for verification' : ''}
${config.status === 'rejected' ? '❌ Rejected - Please contact support' : ''}

To update your configuration, use /setuptelebirr
    `;

    bot.sendMessage(chatId, viewMessage, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error viewing config:', error);
    bot.sendMessage(chatId, '❌ Failed to fetch configuration.');
  }
});

// =====================
// CALLBACK QUERY HANDLER
// =====================

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;

  // Help callback
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
/setuptelebirr - Set up Telebirr configuration
/viewtelebirr - View your Telebirr configuration
/cancel - Cancel current upload

For support: @habesha_support
    `;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Upload callback
  if (data === 'upload') {
    bot.emit('text', { chat: { id: chatId }, from: { id: userId }, text: '/upload' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Telebirr setup callback
  if (data === 'setuptelebirr') {
    bot.emit('text', { chat: { id: chatId }, from: { id: userId }, text: '/setuptelebirr' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Telebirr update
  if (data === 'update_telebirr') {
    tempTelebirrConfig[userId] = {
      step: 'number',
      data: {}
    };

    const updateMessage = `
📱 *Update Telebirr Configuration*

*Step 1 of 2: Enter New Telebirr Number*

Please enter your new Telebirr phone number.

Format: 09XXXXXXXX

Type /cancel to cancel the update.
    `;

    bot.sendMessage(chatId, updateMessage, { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'keep_telebirr') {
    bot.sendMessage(chatId, '✅ Keeping current configuration.');
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Telebirr Approval
  if (data.startsWith('approve_telebirr_')) {
    const configId = data.replace('approve_telebirr_', '');
    await approveTelebirrConfig(configId, userId, chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Telebirr Rejection
  if (data.startsWith('reject_telebirr_')) {
    const configId = data.replace('reject_telebirr_', '');
    await rejectTelebirrConfig(configId, userId, chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Upload confirmation
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

  // Payment approval (existing)
  if (data.startsWith('approve_payment_')) {
    const purchaseId = data.replace('approve_payment_', '');
    await approvePayment(purchaseId, userId, chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data.startsWith('reject_payment_')) {
    const purchaseId = data.replace('reject_payment_', '');
    await rejectPayment(purchaseId, userId, chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// =====================
// APPROVAL FUNCTIONS
// =====================

async function approveTelebirrConfig(configId, adminTelegramId, chatId) {
  try {
    const admin = await User.findOne({ telegramId: adminTelegramId });
    if (!admin || admin.adminRole !== 'super_admin') {
      return bot.sendMessage(chatId, '❌ Only super admins can approve Telebirr configurations.');
    }

    const config = await AdminConfig.findById(configId).populate('adminId');
    if (!config) {
      return bot.sendMessage(chatId, '❌ Configuration not found.');
    }

    if (config.status !== 'pending') {
      return bot.sendMessage(chatId, `ℹ️ This configuration is already ${config.status}.`);
    }

    config.status = 'approved';
    config.approvedBy = admin._id;
    config.approvedAt = new Date();
    await config.save();

    // Notify the admin (they don't know about main admin)
    try {
      await bot.sendMessage(
        config.telegramId,
        `✅ *Telebirr Configuration Verified!*

Your Telebirr configuration has been verified and approved.

📱 *Number:* ${config.telebirrNumber}
📊 *Status:* ✅ Approved

You can now accept payments through Telebirr.

Thank you for your patience! 🙏
        `,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Failed to notify admin:', error);
    }

    // Notify all super admins
    const superAdmins = await User.find({ adminRole: 'super_admin' });
    for (const superAdmin of superAdmins) {
      try {
        await bot.sendMessage(
          superAdmin.telegramId,
          `✅ *Telebirr Configuration Approved*

👤 *Admin:* ${config.adminName}
📱 *Number:* ${config.telebirrNumber}
👤 *Approved by:* ${admin.name}
📅 *Date:* ${new Date().toLocaleString()}
          `,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Failed to notify super admin:', error);
      }
    }

    bot.sendMessage(chatId, `✅ Telebirr configuration approved successfully!`);

  } catch (error) {
    console.error('Approval error:', error);
    bot.sendMessage(chatId, '❌ Failed to approve configuration.');
  }
}

async function rejectTelebirrConfig(configId, adminTelegramId, chatId) {
  try {
    const admin = await User.findOne({ telegramId: adminTelegramId });
    if (!admin || admin.adminRole !== 'super_admin') {
      return bot.sendMessage(chatId, '❌ Only super admins can reject Telebirr configurations.');
    }

    const config = await AdminConfig.findById(configId).populate('adminId');
    if (!config) {
      return bot.sendMessage(chatId, '❌ Configuration not found.');
    }

    if (config.status !== 'pending') {
      return bot.sendMessage(chatId, `ℹ️ This configuration is already ${config.status}.`);
    }

    config.status = 'rejected';
    config.approvedBy = admin._id;
    config.approvedAt = new Date();
    await config.save();

    // Notify the admin
    try {
      await bot.sendMessage(
        config.telegramId,
        `❌ *Telebirr Configuration Rejected*

Your Telebirr configuration has been rejected.

📱 *Number:* ${config.telebirrNumber}
📊 *Status:* ❌ Rejected

Please contact support for more information.
You can try again with /setuptelebirr
        `,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Failed to notify admin:', error);
    }

    // Notify all super admins
    const superAdmins = await User.find({ adminRole: 'super_admin' });
    for (const superAdmin of superAdmins) {
      try {
        await bot.sendMessage(
          superAdmin.telegramId,
          `❌ *Telebirr Configuration Rejected*

👤 *Admin:* ${config.adminName}
📱 *Number:* ${config.telebirrNumber}
👤 *Rejected by:* ${admin.name}
📅 *Date:* ${new Date().toLocaleString()}
          `,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Failed to notify super admin:', error);
      }
    }

    bot.sendMessage(chatId, `❌ Telebirr configuration rejected.`);

  } catch (error) {
    console.error('Rejection error:', error);
    bot.sendMessage(chatId, '❌ Failed to reject configuration.');
  }
}

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

    delete tempUploads[userId];

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
// PAYMENT HANDLERS (Existing)
// =====================

async function approvePayment(purchaseId, adminTelegramId, chatId) {
  try {
    const admin = await User.findOne({ telegramId: adminTelegramId });
    if (!admin || !admin.isAdmin) {
      return bot.sendMessage(chatId, '❌ You do not have permission to approve payments.');
    }

    const purchase = await Purchase.findById(purchaseId).populate('mediaId').populate('userId');
    if (!purchase) {
      return bot.sendMessage(chatId, '❌ Purchase not found.');
    }

    if (purchase.status === 'completed') {
      return bot.sendMessage(chatId, 'ℹ️ This payment has already been approved.');
    }

    purchase.status = 'completed';
    purchase.adminApprovedBy = admin._id;
    purchase.approvedAt = new Date();
    await purchase.save();

    await User.findByIdAndUpdate(purchase.userId, {
      $addToSet: { purchases: purchase.mediaId }
    });

    try {
      await bot.sendMessage(purchase.userId.telegramId,
        `✅ *Payment Approved!*\n\n` +
        `Your payment for "${purchase.mediaId.title}" has been approved.\n` +
        `💰 Amount: $${purchase.amount}\n` +
        `📅 Date: ${new Date().toLocaleString()}\n\n` +
        `You can now access the content in the app! 🎉`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📱 Open App', web_app: { url: process.env.APP_URL } }]
            ]
          }
        }
      );
    } catch (error) {
      console.error('Failed to notify user:', error);
    }

    const admins = await User.find({ isAdmin: true });
    for (const adminUser of admins) {
      try {
        await bot.sendMessage(adminUser.telegramId,
          `✅ *Payment Approved*\n\n` +
          `Purchase ID: ${purchase._id}\n` +
          `User: ${purchase.userId.name}\n` +
          `Content: ${purchase.mediaId.title}\n` +
          `Amount: $${purchase.amount}\n` +
          `Approved by: ${admin.name}\n` +
          `Date: ${new Date().toLocaleString()}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Failed to notify admin:', error);
      }
    }

    bot.sendMessage(chatId, `✅ Payment approved successfully! User has been notified.`);

  } catch (error) {
    console.error('Approval error:', error);
    bot.sendMessage(chatId, '❌ Failed to approve payment.');
  }
}

async function rejectPayment(purchaseId, adminTelegramId, chatId) {
  try {
    const admin = await User.findOne({ telegramId: adminTelegramId });
    if (!admin || !admin.isAdmin) {
      return bot.sendMessage(chatId, '❌ You do not have permission to reject payments.');
    }

    const purchase = await Purchase.findById(purchaseId).populate('mediaId').populate('userId');
    if (!purchase) {
      return bot.sendMessage(chatId, '❌ Purchase not found.');
    }

    if (purchase.status === 'completed') {
      return bot.sendMessage(chatId, 'ℹ️ This payment has already been approved.');
    }

    purchase.status = 'failed';
    purchase.adminApprovedBy = admin._id;
    await purchase.save();

    try {
      await bot.sendMessage(purchase.userId.telegramId,
        `❌ *Payment Rejected*\n\n` +
        `Your payment for "${purchase.mediaId.title}" has been rejected.\n` +
        `💰 Amount: $${purchase.amount}\n` +
        `📅 Date: ${new Date().toLocaleString()}\n\n` +
        `Please contact support for more information.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📱 Open App', web_app: { url: process.env.APP_URL } }]
            ]
          }
        }
      );
    } catch (error) {
      console.error('Failed to notify user:', error);
    }

    const admins = await User.find({ isAdmin: true });
    for (const adminUser of admins) {
      try {
        await bot.sendMessage(adminUser.telegramId,
          `❌ *Payment Rejected*\n\n` +
          `Purchase ID: ${purchase._id}\n` +
          `User: ${purchase.userId.name}\n` +
          `Content: ${purchase.mediaId.title}\n` +
          `Amount: $${purchase.amount}\n` +
          `Rejected by: ${admin.name}\n` +
          `Date: ${new Date().toLocaleString()}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Failed to notify admin:', error);
      }
    }

    bot.sendMessage(chatId, `❌ Payment rejected. User has been notified.`);

  } catch (error) {
    console.error('Rejection error:', error);
    bot.sendMessage(chatId, '❌ Failed to reject payment.');
  }
}

// =====================
// API ENDPOINTS
// =====================

// Root route
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

// API Documentation
app.get('/api/docs', (req, res) => {
  res.json({
    endpoints: {
      'POST /api/auth/telegram': 'Authenticate user with Telegram',
      'GET /api/media': 'Get all media content',
      'GET /api/media/:id': 'Get single media by ID',
      'POST /api/payment/initiate': 'Initiate payment',
      'POST /api/payment/screenshot': 'Upload payment screenshot',
      'GET /api/payment/status/:purchaseId': 'Get payment status',
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
    }
  });
});

// Auth endpoint
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

// Payment endpoints
app.post('/api/payment/initiate', authenticate, async (req, res) => {
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

    const pendingPurchase = await Purchase.findOne({
      userId,
      mediaId,
      status: 'awaiting_confirmation'
    });

    if (pendingPurchase) {
      return res.json({
        purchaseId: pendingPurchase._id,
        amount: media.price,
        status: 'awaiting_confirmation',
        message: 'Payment already pending confirmation'
      });
    }

    // Get approved admin config
    const adminConfig = await AdminConfig.findOne({ 
      status: 'approved',
      isActive: true 
    }).populate('adminId');

    if (!adminConfig) {
      return res.status(500).json({ 
        error: 'No admin with approved Telebirr configuration found.' 
      });
    }

    const purchase = new Purchase({
      userId,
      mediaId,
      amount: media.price,
      status: 'awaiting_confirmation',
      paymentMethod: 'telebirr',
      paymentId: 'telebirr_' + Date.now()
    });

    await purchase.save();

    res.json({
      purchaseId: purchase._id,
      amount: media.price,
      telebirrNumber: adminConfig.telebirrNumber,
      message: 'Please send payment to Telebirr number and upload screenshot',
      status: 'awaiting_confirmation'
    });
  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

app.post('/api/payment/screenshot', authenticate, upload.single('screenshot'), async (req, res) => {
  try {
    const { purchaseId } = req.body;
    const userId = req.user._id;

    if (!req.file) {
      return res.status(400).json({ error: 'Screenshot is required' });
    }

    const purchase = await Purchase.findOne({ _id: purchaseId, userId });
    if (!purchase) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    if (purchase.status === 'completed') {
      return res.status(400).json({ error: 'Already completed' });
    }

    purchase.screenshot = req.file.filename;
    purchase.status = 'awaiting_confirmation';
    await purchase.save();

    const user = await User.findById(userId);
    const media = await Media.findById(purchase.mediaId);

    const admins = await User.find({ isAdmin: true });
    for (const admin of admins) {
      try {
        const screenshotUrl = `${process.env.APP_URL}/uploads/${req.file.filename}`;
        
        await bot.sendPhoto(admin.telegramId, screenshotUrl, {
          caption: 
`💳 *New Payment Confirmation*

👤 *User:* ${user.name} (@${user.username || 'N/A'})
📱 *Telegram ID:* ${user.telegramId}
📌 *Content:* ${media.title}
💰 *Amount:* $${purchase.amount}
🆔 *Purchase ID:* ${purchase._id}
📅 *Date:* ${new Date().toLocaleString()}

Please verify the payment and approve using the buttons below.`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve Payment', callback_data: `approve_payment_${purchase._id}` },
                { text: '❌ Reject Payment', callback_data: `reject_payment_${purchase._id}` }
              ]
            ]
          }
        });
      } catch (error) {
        console.error('Failed to notify admin:', error);
      }
    }

    res.json({
      success: true,
      message: 'Payment screenshot uploaded. Waiting for admin approval.',
      purchaseId: purchase._id
    });
  } catch (error) {
    console.error('Screenshot upload error:', error);
    res.status(500).json({ error: 'Failed to upload screenshot' });
  }
});

app.get('/api/payment/status/:purchaseId', authenticate, async (req, res) => {
  try {
    const { purchaseId } = req.params;
    const userId = req.user._id;

    const purchase = await Purchase.findOne({ _id: purchaseId, userId })
      .populate('mediaId', 'title price')
      .populate('adminApprovedBy', 'name username');

    if (!purchase) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    res.json({
      status: purchase.status,
      amount: purchase.amount,
      media: purchase.mediaId,
      screenshot: purchase.screenshot ? `${process.env.APP_URL}/uploads/${purchase.screenshot}` : null,
      adminApprovedBy: purchase.adminApprovedBy,
      approvedAt: purchase.approvedAt,
      createdAt: purchase.createdAt
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

// Media endpoints
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

// Admin Media endpoints
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

// Admin Management endpoints
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

// User Management endpoints
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

// Purchases endpoint
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

// Admin Stats
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

// Broadcast endpoint
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    message: 'Please check the API documentation at /api/docs'
  });
});

// Error handler
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
