require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const TelegramBot = require('node-telegram-bot-api');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialize Express
const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use('/api/', limiter);

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Database Models
const User = require('./models/User');
const Media = require('./models/Media');
const Purchase = require('./models/Purchase');
const Transaction = require('./models/Transaction');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB connection error:', err));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
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
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Authentication middleware
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

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const isAdmin = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// =====================
// TELEGRAM BOT COMMANDS
// =====================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user exists
  let user = await User.findOne({ telegramId: userId });
  if (!user) {
    user = new User({
      telegramId: userId,
      username: msg.from.username || '',
      name: msg.from.first_name || '',
      isAdmin: userId.toString() === process.env.ADMIN_ID
    });
    await user.save();
  }

  const welcomeMessage = `
🎬 Welcome to Habesha!

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
        [{ text: 'ℹ️ Help', callback_data: 'help' }]
      ]
    }
  };

  bot.sendMessage(chatId, welcomeMessage, options);
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📚 Help & Support

How to use Habesha:
1. Click "Open App" to start
2. Browse content in Videos & Photos
3. Tap on content to see details
4. Purchase to unlock full access
5. View your purchases in "My Library"

For support: @habesha_support
  `;
  bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/profile/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    return bot.sendMessage(chatId, 'Please start the app first: /start');
  }

  const purchases = await Purchase.find({ userId: user._id });
  const profileMessage = `
👤 Profile

Name: ${user.name}
Username: @${user.username || 'Not set'}
Total Purchases: ${purchases.length}
Member Since: ${new Date(user.createdAt).toLocaleDateString()}

Click "Open App" to view your library!
  `;

  bot.sendMessage(chatId, profileMessage, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Open App', web_app: { url: process.env.APP_URL } }]
      ]
    }
  });
});

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;

  if (data === 'help') {
    const helpMessage = `
📚 Help & Support

How to use Habesha:
1. Click "Open App" to start
2. Browse content in Videos & Photos
3. Tap on content to see details
4. Purchase to unlock full access
5. View your purchases in "My Library"

For support: @habesha_support
    `;
    bot.sendMessage(msg.chat.id, helpMessage);
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// =====================
// API ENDPOINTS
// =====================

// Auth endpoints
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { telegramId, username, name } = req.body;
    
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({
        telegramId,
        username: username || '',
        name: name || '',
        isAdmin: telegramId.toString() === process.env.ADMIN_ID
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, isAdmin: user.isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
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

    // Add purchase status for each media
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

    // Increment view count
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

// Purchase endpoints
app.post('/api/purchase/initiate', authenticate, async (req, res) => {
  try {
    const { mediaId } = req.body;
    const userId = req.user._id;

    const media = await Media.findById(mediaId);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Check if already purchased
    const existingPurchase = await Purchase.findOne({
      userId,
      mediaId,
      status: 'completed'
    });

    if (existingPurchase) {
      return res.status(400).json({ error: 'Already purchased' });
    }

    if (media.price === 0) {
      // Free content - just create purchase record
      const purchase = new Purchase({
        userId,
        mediaId,
        amount: 0,
        status: 'completed',
        paymentId: 'free_' + Date.now()
      });
      await purchase.save();

      // Notify admin
      const adminUser = await User.findOne({ isAdmin: true });
      if (adminUser) {
        bot.sendMessage(adminUser.telegramId, 
          `📥 New free content accessed\nUser: ${req.user.name}\nContent: ${media.title}`
        );
      }

      return res.json({ success: true, free: true });
    }

    // Paid content - create pending purchase
    const purchase = new Purchase({
      userId,
      mediaId,
      amount: media.price,
      status: 'pending',
      paymentId: 'pending_' + Date.now()
    });
    await purchase.save();

    // Generate payment URL (simplified - integrate with actual payment provider)
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

    // Verify payment (integrate with actual payment gateway)
    // For now, we'll simulate verification
    const isVerified = true;

    if (isVerified) {
      purchase.status = 'completed';
      purchase.paymentId = paymentId || 'verified_' + Date.now();
      await purchase.save();

      // Add to user's purchases
      await User.findByIdAndUpdate(userId, {
        $addToSet: { purchases: purchase.mediaId }
      });

      // Notify admin
      const adminUser = await User.findOne({ isAdmin: true });
      if (adminUser) {
        const media = await Media.findById(purchase.mediaId);
        bot.sendMessage(adminUser.telegramId, 
          `💰 New purchase\nUser: ${req.user.name}\nContent: ${media.title}\nAmount: ${purchase.amount}`
        );
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

// Admin endpoints
app.post('/api/admin/media', authenticate, isAdmin, upload.single('file'), async (req, res) => {
  try {
    const { title, description, type, category, price } = req.body;
    
    // Validate file
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
      thumbnail: req.file.filename, // In production, generate actual thumbnail
      uploadedBy: req.user._id
    });

    await media.save();

    // Notify admin
    bot.sendMessage(process.env.ADMIN_ID, 
      `✅ New content uploaded\nTitle: ${title}\nType: ${type}\nPrice: ${price}`
    );

    res.status(201).json(media);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.put('/api/admin/media/:id', authenticate, isAdmin, async (req, res) => {
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

    res.json(media);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.delete('/api/admin/media/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Delete file from filesystem
    if (media.file) {
      const filePath = path.join(__dirname, 'uploads', media.file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await media.remove();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/api/admin/stats', authenticate, isAdmin, async (req, res) => {
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

    res.json({
      totalUsers,
      totalMedia,
      totalPurchases,
      totalEarnings: totalEarnings[0]?.total || 0,
      recentPurchases
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.post('/api/admin/broadcast', authenticate, isAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    
    const users = await User.find({});
    let sentCount = 0;

    for (const user of users) {
      try {
        await bot.sendMessage(user.telegramId, 
          `📢 Announcement from Habesha\n\n${message}`
        );
        sentCount++;
      } catch (error) {
        console.error(`Failed to send to user ${user.telegramId}:`, error);
      }
    }

    res.json({ success: true, sentCount });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ error: 'Broadcast failed' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
