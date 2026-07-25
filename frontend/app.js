// Habesha Telegram Mini App - Frontend JavaScript

const API_URL = 'https://your-api-url.com'; // Replace with your actual API URL

// App State
const state = {
    user: null,
    token: null,
    currentPage: 'home',
    currentCategory: 'all',
    media: [],
    purchases: [],
    isAdmin: false,
    cart: []
};

// DOM Elements
const elements = {
    splash: document.getElementById('splash'),
    app: document.getElementById('app'),
    pages: {
        home: document.getElementById('homePage'),
        videos: document.getElementById('videosPage'),
        photos: document.getElementById('photosPage'),
        library: document.getElementById('libraryPage'),
        profile: document.getElementById('profilePage'),
        admin: document.getElementById('adminPage')
    },
    navItems: document.querySelectorAll('.nav-item'),
    homeContent: document.getElementById('homeContent'),
    videosContent: document.getElementById('videosContent'),
    photosContent: document.getElementById('photosContent'),
    libraryContent: document.getElementById('libraryContent'),
    profileName: document.getElementById('profileName'),
    profileUsername: document.getElementById('profileUsername'),
    purchaseCount: document.getElementById('purchaseCount'),
    favoriteCount: document.getElementById('favoriteCount'),
    searchBar: document.getElementById('searchBar'),
    searchInput: document.getElementById('searchInput'),
    contentModal: document.getElementById('contentModal'),
    modalContent: document.getElementById('modalContent'),
    uploadModal: document.getElementById('uploadModal'),
    uploadForm: document.getElementById('uploadForm'),
    broadcastModal: document.getElementById('broadcastModal'),
    broadcastForm: document.getElementById('broadcastForm'),
    paymentModal: document.getElementById('paymentModal'),
    paymentContent: document.getElementById('paymentContent'),
    menuBtn: document.getElementById('menuBtn'),
    searchBtn: document.getElementById('searchBtn'),
    searchClose: document.getElementById('searchClose'),
    notificationBtn: document.getElementById('notificationBtn'),
    uploadBtn: document.getElementById('uploadBtn'),
    broadcastBtn: document.getElementById('broadcastBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    categoryBtns: document.querySelectorAll('.category-btn'),
    totalUsers: document.getElementById('totalUsers'),
    totalMedia: document.getElementById('totalMedia'),
    totalPurchases: document.getElementById('totalPurchases'),
    totalEarnings: document.getElementById('totalEarnings')
};

// =====================
// TELEGRAM INTEGRATION
// =====================

// Initialize Telegram Web App
const tg = window.Telegram?.WebApp;

async function initTelegram() {
    if (tg) {
        tg.ready();
        tg.expand();
        
        const user = tg.initDataUnsafe?.user;
        if (user) {
            await authenticateUser(user);
        }
    } else {
        // Development fallback
        console.log('Running outside Telegram');
        // You can add a development login here
    }
}

async function authenticateUser(telegramUser) {
    try {
        const response = await fetch(`${API_URL}/api/auth/telegram`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telegramId: telegramUser.id,
                username: telegramUser.username,
                name: telegramUser.first_name
            })
        });

        if (!response.ok) throw new Error('Authentication failed');

        const data = await response.json();
        state.token = data.token;
        state.user = data.user;
        state.isAdmin = data.user.isAdmin;

        localStorage.setItem('habesha_token', data.token);
        localStorage.setItem('habesha_user', JSON.stringify(data.user));

        showNotification('Welcome to Habesha!', 'success');
        initializeApp();
    } catch (error) {
        console.error('Authentication error:', error);
        showNotification('Authentication failed', 'error');
    }
}

// =====================
// APP INITIALIZATION
// =====================

function initializeApp() {
    // Hide splash screen
    setTimeout(() => {
        elements.splash.classList.add('hidden');
    }, 1500);

    // Load initial data
    loadHomeContent();
    loadProfile();

    // Setup event listeners
    setupEventListeners();

    // Check for admin
    if (state.isAdmin) {
        showAdminDashboard();
        loadAdminStats();
    }

    // Show Telegram main button if available
    if (tg) {
        tg.MainButton.hide();
    }
}

function setupEventListeners() {
    // Navigation
    elements.navItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            navigateTo(page);
        });
    });

    // Search
    elements.searchBtn.addEventListener('click', toggleSearch);
    elements.searchClose.addEventListener('click', toggleSearch);
    elements.searchInput.addEventListener('input', debounce(handleSearch, 300));

    // Categories
    elements.categoryBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.categoryBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.currentCategory = btn.dataset.category;
            loadHomeContent();
        });
    });

    // Modals
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('.modal').classList.remove('active');
        });
    });

    // Close modal on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });

    // Admin actions
    if (elements.uploadBtn) {
        elements.uploadBtn.addEventListener('click', () => {
            elements.uploadModal.classList.add('active');
        });
    }

    if (elements.broadcastBtn) {
        elements.broadcastBtn.addEventListener('click', () => {
            elements.broadcastModal.classList.add('active');
        });
    }

    // Logout
    elements.logoutBtn.addEventListener('click', logout);

    // Upload form
    elements.uploadForm.addEventListener('submit', handleUpload);

    // Broadcast form
    elements.broadcastForm.addEventListener('submit', handleBroadcast);

    // Menu button
    elements.menuBtn.addEventListener('click', () => {
        // Show admin panel if admin
        if (state.isAdmin) {
            navigateTo('admin');
        }
    });
}

// =====================
// NAVIGATION
// =====================

function navigateTo(page) {
    // Hide all pages
    Object.values(elements.pages).forEach(p => p.classList.remove('active'));

    // Show selected page
    if (page === 'admin' && state.isAdmin) {
        elements.pages.admin.classList.add('active');
    } else {
        const pageMap = {
            home: elements.pages.home,
            videos: elements.pages.videos,
            photos: elements.pages.photos,
            library: elements.pages.library,
            profile: elements.pages.profile
        };
        
        if (pageMap[page]) {
            pageMap[page].classList.add('active');
        }
    }

    // Update nav
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    state.currentPage = page;

    // Load page content
    switch(page) {
        case 'home':
            loadHomeContent();
            break;
        case 'videos':
            loadVideos();
            break;
        case 'photos':
            loadPhotos();
            break;
        case 'library':
            loadLibrary();
            break;
        case 'profile':
            loadProfile();
            break;
        case 'admin':
            loadAdminStats();
            break;
    }
}

// =====================
// CONTENT LOADING
// =====================

async function loadHomeContent() {
    try {
        const category = state.currentCategory === 'all' ? '' : `&category=${state.currentCategory}`;
        const response = await fetch(`${API_URL}/api/media?${category}`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load content');

        const media = await response.json();
        state.media = media;
        renderContent(elements.homeContent, media);
    } catch (error) {
        console.error('Error loading home content:', error);
        showNotification('Failed to load content', 'error');
    }
}

async function loadVideos() {
    try {
        const response = await fetch(`${API_URL}/api/media?type=video`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load videos');

        const media = await response.json();
        renderContent(elements.videosContent, media);
    } catch (error) {
        console.error('Error loading videos:', error);
        showNotification('Failed to load videos', 'error');
    }
}

async function loadPhotos() {
    try {
        const response = await fetch(`${API_URL}/api/media?type=photo`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load photos');

        const media = await response.json();
        renderPhotoGrid(elements.photosContent, media);
    } catch (error) {
        console.error('Error loading photos:', error);
        showNotification('Failed to load photos', 'error');
    }
}

async function loadLibrary() {
    try {
        const response = await fetch(`${API_URL}/api/purchases`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load library');

        const purchases = await response.json();
        state.purchases = purchases;
        const media = purchases.map(p => p.mediaId).filter(m => m);
        renderContent(elements.libraryContent, media);
    } catch (error) {
        console.error('Error loading library:', error);
        showNotification('Failed to load library', 'error');
    }
}

async function loadProfile() {
    if (!state.user) return;

    elements.profileName.textContent = state.user.name || 'User';
    elements.profileUsername.textContent = `@${state.user.username || 'username'}`;
    elements.purchaseCount.textContent = state.purchases?.length || 0;
    elements.favoriteCount.textContent = state.user.favorites?.length || 0;
}

async function loadAdminStats() {
    if (!state.isAdmin) return;

    try {
        const response = await fetch(`${API_URL}/api/admin/stats`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load stats');

        const stats = await response.json();
        elements.totalUsers.textContent = stats.totalUsers || 0;
        elements.totalMedia.textContent = stats.totalMedia || 0;
        elements.totalPurchases.textContent = stats.totalPurchases || 0;
        elements.totalEarnings.textContent = `$${(stats.totalEarnings || 0).toFixed(2)}`;
    } catch (error) {
        console.error('Error loading admin stats:', error);
        showNotification('Failed to load admin stats', 'error');
    }
}

// =====================
// RENDER FUNCTIONS
// =====================

function renderContent(container, media) {
    if (!media || media.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-box-open" style="font-size: 48px; color: var(--text-secondary);"></i>
                <p style="color: var(--text-secondary); margin-top: 15px;">No content available</p>
            </div>
        `;
        return;
    }

    container.innerHTML = media.map(item => `
        <div class="content-card" onclick="openContent('${item._id}')">
            <div class="thumbnail">
                ${item.type === 'video' ? 
                    `<i class="fas fa-play-circle"></i>` : 
                    `<i class="fas fa-image"></i>`
                }
                ${item.price > 0 ? `<span class="badge">$${item.price}</span>` : ''}
                ${item.isPurchased ? `<span class="badge" style="background: var(--success);">✓ Unlocked</span>` : ''}
            </div>
            <div class="info">
                <h3>${item.title}</h3>
                <p>${item.category}</p>
                ${item.price > 0 ? `<span class="price-tag">$${item.price}</span>` : '<span class="price-tag" style="background: var(--success);">Free</span>'}
            </div>
        </div>
    `).join('');
}

function renderPhotoGrid(container, media) {
    if (!media || media.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <i class="fas fa-image" style="font-size: 48px; color: var(--text-secondary);"></i>
                <p style="color: var(--text-secondary); margin-top: 15px;">No photos available</p>
            </div>
        `;
        return;
    }

    container.innerHTML = media.map(item => `
        <div class="photo-item" onclick="openContent('${item._id}')">
            <i class="fas fa-image" style="font-size: 40px; color: var(--text-secondary);"></i>
            ${item.isPurchased ? '<span class="badge" style="position: absolute; top: 5px; right: 5px; background: var(--success); font-size: 10px;">✓</span>' : ''}
        </div>
    `).join('');
}

// =====================
// CONTENT DETAILS
// =====================

async function openContent(mediaId) {
    try {
        const response = await fetch(`${API_URL}/api/media/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Failed to load content');

        const media = await response.json();
        showContentModal(media);
    } catch (error) {
        console.error('Error opening content:', error);
        showNotification('Failed to open content', 'error');
    }
}

function showContentModal(media) {
    const isPurchased = media.isPurchased || media.isFree;
    const canAccess = isPurchased || media.price === 0;

    elements.modalContent.innerHTML = `
        <div style="margin-bottom: 20px;">
            ${media.type === 'video' ? `
                <div class="video-player">
                    ${canAccess ? 
                        `<video controls src="${API_URL}/uploads/${media.file}"></video>` :
                        `<div style="padding: 40px; text-align: center; background: var(--primary-dark); border-radius: var(--radius);">
                            <i class="fas fa-lock" style="font-size: 48px; color: var(--secondary);"></i>
                            <p style="margin-top: 15px; color: var(--text-secondary);">This content is locked</p>
                            <p style="color: var(--secondary); font-size: 24px; font-weight: bold;">$${media.price}</p>
                        </div>`
                    }
                </div>
            ` : `
                <div class="image-viewer">
                    ${canAccess ? 
                        `<img src="${API_URL}/uploads/${media.file}" alt="${media.title}">` :
                        `<div style="padding: 40px; text-align: center; background: var(--primary-dark); border-radius: var(--radius);">
                            <i class="fas fa-lock" style="font-size: 48px; color: var(--secondary);"></i>
                            <p style="margin-top: 15px; color: var(--text-secondary);">This content is locked</p>
                            <p style="color: var(--secondary); font-size: 24px; font-weight: bold;">$${media.price}</p>
                        </div>`
                    }
                </div>
            `}
        </div>
        <div>
            <h2 style="font-size: 24px; margin-bottom: 10px;">${media.title}</h2>
            <p style="color: var(--text-secondary); margin-bottom: 15px;">${media.description || 'No description available'}</p>
            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                <span style="background: var(--surface-light); padding: 4px 12px; border-radius: 12px; font-size: 14px;">${media.category}</span>
                <span style="background: var(--surface-light); padding: 4px 12px; border-radius: 12px; font-size: 14px;">${media.type}</span>
                <span style="background: var(--surface-light); padding: 4px 12px; border-radius: 12px; font-size: 14px;">${media.views || 0} views</span>
            </div>
            ${!canAccess && media.price > 0 ? `
                <button onclick="purchaseContent('${media._id}')" class="btn btn-primary" style="width: 100%; margin-top: 20px;">
                    <i class="fas fa-shopping-cart"></i> Purchase for $${media.price}
                </button>
            ` : ''}
            ${canAccess && media.type === 'video' ? `
                <button onclick="toggleFullscreen()" class="btn btn-secondary" style="width: 100%; margin-top: 10px;">
                    <i class="fas fa-expand"></i> Fullscreen
                </button>
            ` : ''}
        </div>
    `;

    elements.contentModal.classList.add('active');
}

// =====================
// PURCHASE FUNCTIONS
// =====================

async function purchaseContent(mediaId) {
    try {
        const response = await fetch(`${API_URL}/api/purchase/initiate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ mediaId })
        });

        if (!response.ok) throw new Error('Purchase initiation failed');

        const data = await response.json();

        if (data.free) {
            showNotification('Content unlocked!', 'success');
            elements.contentModal.classList.remove('active');
            loadHomeContent();
            return;
        }

        // Show payment modal
        showPaymentModal(data);
    } catch (error) {
        console.error('Purchase error:', error);
        showNotification('Purchase failed', 'error');
    }
}

function showPaymentModal(purchaseData) {
    elements.paymentContent.innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-credit-card" style="font-size: 48px; color: var(--secondary);"></i>
            <h2 style="margin: 20px 0 10px;">Complete Payment</h2>
            <p style="color: var(--text-secondary);">Amount: $${purchaseData.amount}</p>
            <div style="margin: 30px 0; padding: 20px; background: var(--background); border-radius: var(--radius);">
                <p style="color: var(--text-secondary);">Payment Instructions:</p>
                <p style="font-size: 14px; margin-top: 10px;">1. Click the button below</p>
                <p style="font-size: 14px;">2. Complete payment process</p>
                <p style="font-size: 14px;">3. Return to the app</p>
            </div>
            <button onclick="verifyPayment('${purchaseData.purchaseId}')" class="btn btn-primary" style="width: 100%;">
                <i class="fas fa-check"></i> Complete Payment
            </button>
            <button onclick="closePaymentModal()" class="btn btn-secondary" style="width: 100%; margin-top: 10px;">
                Cancel
            </button>
        </div>
    `;

    elements.paymentModal.classList.add('active');
}

async function verifyPayment(purchaseId) {
    try {
        const response = await fetch(`${API_URL}/api/purchase/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({
                purchaseId,
                paymentId: 'verified_' + Date.now()
            })
        });

        if (!response.ok) throw new Error('Payment verification failed');

        const data = await response.json();
        
        if (data.success) {
            showNotification('Payment successful! Content unlocked!', 'success');
            closePaymentModal();
            elements.contentModal.classList.remove('active');
            loadHomeContent();
            loadLibrary();
            loadProfile();
        } else {
            showNotification('Payment verification failed', 'error');
        }
    } catch (error) {
        console.error('Verification error:', error);
        showNotification('Payment verification failed', 'error');
    }
}

function closePaymentModal() {
    elements.paymentModal.classList.remove('active');
}

function toggleFullscreen() {
    const video = document.querySelector('video');
    if (video) {
        if (video.requestFullscreen) {
            video.requestFullscreen();
        } else if (video.webkitRequestFullscreen) {
            video.webkitRequestFullscreen();
        }
    }
}

// =====================
// SEARCH
// =====================

function toggleSearch() {
    elements.searchBar.classList.toggle('hidden');
    if (!elements.searchBar.classList.contains('hidden')) {
        elements.searchInput.focus();
    } else {
        elements.searchInput.value = '';
        loadHomeContent();
    }
}

async function handleSearch() {
    const query = elements.searchInput.value.trim();
    if (!query) {
        loadHomeContent();
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/media?search=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });

        if (!response.ok) throw new Error('Search failed');

        const media = await response.json();
        renderContent(elements.homeContent, media);
    } catch (error) {
        console.error('Search error:', error);
        showNotification('Search failed', 'error');
    }
}

// =====================
// ADMIN FUNCTIONS
// =====================

async function handleUpload(e) {
    e.preventDefault();

    const formData = new FormData();
    formData.append('title', document.getElementById('uploadTitle').value);
    formData.append('description', document.getElementById('uploadDescription').value);
    formData.append('type', document.getElementById('uploadType').value);
    formData.append('category', document.getElementById('uploadCategory').value);
    formData.append('price', document.getElementById('uploadPrice').value);
    formData.append('file', document.getElementById('uploadFile').files[0]);

    try {
        const response = await fetch(`${API_URL}/api/admin/media`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${state.token}`
            },
            body: formData
        });

        if (!response.ok) throw new Error('Upload failed');

        const data = await response.json();
        showNotification('Content uploaded successfully!', 'success');
        elements.uploadModal.classList.remove('active');
        elements.uploadForm.reset();
        loadAdminStats();
        loadHomeContent();
    } catch (error) {
        console.error('Upload error:', error);
        showNotification('Upload failed', 'error');
    }
}

async function handleBroadcast(e) {
    e.preventDefault();

    const message = document.getElementById('broadcastMessage').value;

    try {
        const response = await fetch(`${API_URL}/api/admin/broadcast`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ message })
        });

        if (!response.ok) throw new Error('Broadcast failed');

        const data = await response.json();
        showNotification(`Broadcast sent to ${data.sentCount} users!`, 'success');
        elements.broadcastModal.classList.remove('active');
        elements.broadcastForm.reset();
    } catch (error) {
        console.error('Broadcast error:', error);
        showNotification('Broadcast failed', 'error');
    }
}

function showAdminDashboard() {
    // Add admin page to navigation if not already there
    const adminNavItem = document.createElement('button');
    adminNavItem.className = 'nav-item';
    adminNavItem.dataset.page = 'admin';
    adminNavItem.innerHTML = `<i class="fas fa-cog"></i><span>Admin</span>`;
    
    const nav = document.querySelector('.bottom-nav');
    if (!nav.querySelector('[data-page="admin"]')) {
        nav.appendChild(adminNavItem);
        adminNavItem.addEventListener('click', () => {
            navigateTo('admin');
        });
    }
}

// =====================
// UTILITY FUNCTIONS
// =====================

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 500);
    }, 3000);
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function logout() {
    localStorage.removeItem('habesha_token');
    localStorage.removeItem('habesha_user');
    state.token = null;
    state.user = null;
    location.reload();
}

// =====================
// INITIALIZATION
// =====================

// Check for existing session
const savedToken = localStorage.getItem('habesha_token');
const savedUser = localStorage.getItem('habesha_user');

if (savedToken && savedUser) {
    state.token = savedToken;
    state.user = JSON.parse(savedUser);
    state.isAdmin = state.user.isAdmin;
    initializeApp();
} else {
    initTelegram();
}

// Expose functions to global scope
window.openContent = openContent;
window.purchaseContent = purchaseContent;
window.verifyPayment = verifyPayment;
window.closePaymentModal = closePaymentModal;
window.toggleFullscreen = toggleFullscreen;
window.navigateTo = navigateTo;

// Service Worker for offline support (optional)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .catch(error => console.log('Service worker registration failed:', error));
}

console.log('🎬 Habesha App loaded successfully!');
