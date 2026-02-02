/**
 * NodeCast TV Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'live';
        this.pages = {};
        this.currentUser = null;
        this.passTimers = {};
        this.pendingChannelDataset = null;
        this.pendingWatchPayload = null;

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();

        // Initialize page controllers
        this.pages.live = new LivePage(this);
        this.pages.guide = new GuidePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.watch = new WatchPage(this);

        this.init();
    }

    async init() {
        // Check authentication first
        await this.checkAuth();

        this.initPassUi();

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) {
            mobileMenuToggle.addEventListener('click', () => {
                mobileMenuToggle.classList.toggle('active');
                navbarMenu.classList.toggle('active');
            });

            // Close menu when a nav link is clicked
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                });
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.navbar')) {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                }
            });
        }

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                if (e.target.closest('.channel-item')) {
                    // Small delay to let the channel selection happen
                    setTimeout(() => {
                        channelSidebar.classList.remove('active');
                        channelOverlay.classList.remove('active');
                    }, 300);
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
        const homeLayout = document.querySelector('.home-layout');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');
            homeLayout?.classList.toggle('sidebar-collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
            homeLayout?.classList.add('sidebar-collapsed');
        }

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        // Now Playing indicator
        const nowPlayingBtn = document.getElementById('now-playing-indicator');
        if (nowPlayingBtn) {
            nowPlayingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo('watch');
            });
        }

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Handle browser back/forward buttons
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || 'live';
            this.navigateTo(page, false); // false = don't add to history
        });

        // Preload EPG data in background (non-blocking)
        // This ensures EPG info is available on Live TV page without visiting Guide first
        this.epgGuide.loadEpg().catch(err => {
            console.warn('Background EPG load failed:', err.message);
        });

        // Navigate to the page from URL hash, or default to home
        const hash = window.location.hash.slice(1); // Remove #
        const initialPage = hash && document.getElementById(`page-${hash}`) ? hash : 'live';
        this.navigateTo(initialPage, true); // true = replace history (don't add)

        console.log('NodeCast TV initialized');
    }

    async checkAuth() {
        const token = localStorage.getItem('authToken');

        if (!token) {
            // No token, redirect to login (replace to avoid back button issues)
            window.location.replace('/login.html');
            return;
        }

        try {
            // Verify token with server
            const response = await fetch('/api/auth/me', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();

            // Hide settings for viewers
            if (this.currentUser.role === 'viewer') {
                const settingsLink = document.querySelector('.nav-link[data-page="settings"]');
                if (settingsLink) {
                    settingsLink.style.display = 'none';
                }
            }

            this.applyContentVisibility();

            // Add logout button to navbar
            this.addLogoutButton();

            this.updateAccountSection();

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        }
    }

    initPassUi() {
        const overlayClose = document.getElementById('pass-overlay-close');
        overlayClose?.addEventListener('click', () => this.hidePassOverlay());

        document.querySelectorAll('.pass-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const plan = btn.dataset.plan;
                if (!plan) return;
                await this.redeemPass(plan);
            });
        });

        const historyToggle = document.getElementById('account-coin-history-toggle');
        const historyPanel = document.getElementById('account-coin-history');
        historyToggle?.addEventListener('click', () => {
            historyPanel?.classList.toggle('hidden');
        });

        const passwordForm = document.getElementById('account-password-form');
        if (passwordForm) {
            passwordForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const currentPassword = document.getElementById('account-current-password')?.value;
                const newPassword = document.getElementById('account-new-password')?.value;
                const newPasswordConfirm = document.getElementById('account-new-password-confirm')?.value;

                if (!currentPassword || !newPassword || !newPasswordConfirm) return;
                if (newPassword !== newPasswordConfirm) {
                    alert('Passwörter stimmen nicht überein.');
                    return;
                }

                try {
                    await API.account.changePassword(currentPassword, newPassword);
                    alert('Passwort erfolgreich geändert.');
                    passwordForm.reset();
                } catch (err) {
                    alert('Fehler: ' + err.message);
                }
            });
        }
    }

    hasActivePass() {
        const expires = this.currentUser?.passExpiresAt;
        if (!expires) return false;
        return new Date(expires).getTime() > Date.now();
    }

    getPassRemainingMs() {
        const expires = this.currentUser?.passExpiresAt;
        if (!expires) return 0;
        return Math.max(0, new Date(expires).getTime() - Date.now());
    }

    updateAccountSection() {
        const coinsEl = document.getElementById('account-coins');
        const remainingEl = document.getElementById('account-pass-remaining');
        const untilEl = document.getElementById('account-pass-until');
        const hintEl = document.getElementById('account-pass-hint');

        if (!coinsEl) return;

        const coins = typeof this.currentUser?.coins === 'number' ? this.currentUser.coins : 0;
        coinsEl.textContent = coins;
        coinsEl.classList.toggle('has-coins', coins > 0);
        coinsEl.classList.toggle('no-coins', coins === 0);

        if (this.hasActivePass()) {
            const remainingMs = this.getPassRemainingMs();
            const hours = Math.floor(remainingMs / 3600000);
            const minutes = Math.floor((remainingMs % 3600000) / 60000);
            remainingEl.textContent = `${hours}h ${minutes}m`;
            untilEl.textContent = new Date(this.currentUser.passExpiresAt).toLocaleString();
            if (hintEl) hintEl.textContent = '';
        } else {
            remainingEl.textContent = '—';
            untilEl.textContent = '—';
            if (hintEl) hintEl.textContent = '';
        }
    }

    showPassOverlay({ title, message, autoHideMs } = {}) {
        const overlay = document.getElementById('pass-overlay');
        if (!overlay) return;

        const titleEl = document.getElementById('pass-overlay-title');
        const messageEl = document.getElementById('pass-overlay-message');
        const coinsEl = document.getElementById('pass-overlay-coins');

        if (titleEl) titleEl.textContent = title || 'Kein aktiver Pass';
        if (messageEl) messageEl.textContent = message || 'Du brauchst einen aktiven Pass, um Streams zu starten.';

        const coins = typeof this.currentUser?.coins === 'number' ? this.currentUser.coins : 0;
        if (coinsEl) coinsEl.textContent = coins;

        overlay.classList.remove('hidden');

        if (this.passTimers.autoHide) {
            clearTimeout(this.passTimers.autoHide);
        }
        if (autoHideMs) {
            this.passTimers.autoHide = setTimeout(() => this.hidePassOverlay(), autoHideMs);
        }
    }

    hidePassOverlay() {
        const overlay = document.getElementById('pass-overlay');
        overlay?.classList.add('hidden');
    }

    async redeemPass(plan) {
        try {
            const result = await API.pass.redeem(plan);
            this.currentUser.coins = typeof result.coins === 'number' ? result.coins : 0;
            this.currentUser.passExpiresAt = result.passExpiresAt || null;

            this.hidePassOverlay();
            this.updateAccountSection();
            this.clearPassTimers();
            this.removePassBlur();
            this.onStreamStart();

            if (this.pendingChannelDataset) {
                const dataset = this.pendingChannelDataset;
                this.pendingChannelDataset = null;
                await this.channelList.selectChannel(dataset);
            }

            if (this.pendingWatchPayload) {
                const payload = this.pendingWatchPayload;
                this.pendingWatchPayload = null;
                await this.pages.watch.play(payload.content, payload.streamUrl);
            }
        } catch (err) {
            alert('Fehler: ' + err.message);
        }
    }

    onStreamStart() {
        this.clearPassTimers();

        if (!this.hasActivePass()) {
            this.showPassOverlay({
                title: 'Kein aktiver Pass',
                message: 'Du brauchst einen aktiven Pass, um Streams zu starten.'
            });
            return;
        }

        const remainingMs = this.getPassRemainingMs();
        const warningMs = remainingMs - 30 * 60 * 1000;

        if (warningMs > 0) {
            this.passTimers.warning = setTimeout(() => {
                this.showPassOverlay({
                    title: 'Pass läuft bald ab',
                    message: 'Dein Pass endet in 30 Minuten.',
                    autoHideMs: 30000
                });
            }, warningMs);
        }

        this.passTimers.expire = setTimeout(() => {
            this.handlePassExpired();
        }, remainingMs);
    }

    onStreamStop() {
        this.clearPassTimers();
        this.removePassBlur();
        this.hidePassOverlay();
    }

    handlePassExpired() {
        this.applyPassBlur();
        this.showPassOverlay({
            title: 'Pass abgelaufen',
            message: 'Dein Pass ist abgelaufen. Du kannst jetzt einen neuen Pass einlösen.'
        });

        this.passTimers.grace = setTimeout(() => {
            if (!this.hasActivePass()) {
                this.player?.stop();
            }
        }, 2 * 60 * 1000);
    }

    clearPassTimers() {
        Object.values(this.passTimers).forEach(timer => timer && clearTimeout(timer));
        this.passTimers = {};
    }

    applyPassBlur() {
        document.querySelectorAll('.video-container, .watch-video-section').forEach(el => {
            el.classList.add('pass-blur');
        });
    }

    removePassBlur() {
        document.querySelectorAll('.video-container, .watch-video-section').forEach(el => {
            el.classList.remove('pass-blur');
        });
    }

    addLogoutButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('logout-btn')) return;

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'nav-link';
        logoutLink.id = 'logout-btn';
        logoutLink.innerHTML = `
            <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
            </svg></span>
            <span>Logout</span>
        `;

        logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();

            const token = localStorage.getItem('authToken');
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });
            }

            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        });

        navbar.appendChild(logoutLink);
    }

    applyContentVisibility() {
        const showMovies = !!this.currentUser?.showMovies;
        const showSeries = !!this.currentUser?.showSeries;

        const moviesLink = document.querySelector('.nav-link[data-page="movies"]');
        const seriesLink = document.querySelector('.nav-link[data-page="series"]');
        const moviesPage = document.getElementById('page-movies');
        const seriesPage = document.getElementById('page-series');

        if (moviesLink) moviesLink.style.display = showMovies ? '' : 'none';
        if (seriesLink) seriesLink.style.display = showSeries ? '' : 'none';
        if (moviesPage) moviesPage.style.display = showMovies ? '' : 'none';
        if (seriesPage) seriesPage.style.display = showSeries ? '' : 'none';
    }

    navigateTo(pageName, replaceHistory = false) {
        if (pageName === 'movies' && !this.currentUser?.showMovies) {
            pageName = 'live';
        }

        if (pageName === 'series' && !this.currentUser?.showSeries) {
            pageName = 'live';
        }

        // Don't navigate if already on this page
        if (this.currentPage === pageName && !replaceHistory) {
            return;
        }

        // Update browser history
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            history.replaceState({ page: pageName }, '', `#${pageName}`);
        } else {
            // Add new history entry
            history.pushState({ page: pageName }, '', `#${pageName}`);
        }

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.currentPage = pageName;

        if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();

    // Fetch and display version badge
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const badge = document.getElementById('version-badge');
            if (badge && data.version) badge.textContent = `v${data.version}`;
        })
        .catch(() => { });
});
